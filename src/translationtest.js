import fs from "fs/promises";
import path from "path";
import { AIProjectClient } from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";

const FILE_PATH = process.argv[2];
if (!FILE_PATH) {
  console.error("Usage: node language-file-translator.js <file-path>");
  process.exit(1);
}

async function runAgentConversation(inputText) {
  const project = new AIProjectClient(
    "https://spfx-translation-agent-resource.services.ai.azure.com/api/projects/spfx_translation_agent",
    new DefaultAzureCredential()
  );
  const agent = await project.agents.getAgent("asst_BpV48khjcUWV39cDfcv3D8Nq");
  const thread = await project.agents.threads.create();
  await project.agents.messages.create(thread.id, "user", inputText);
  let run = await project.agents.runs.create(thread.id, agent.id);
  async function pollRunStatus() {
    while (run.status === "queued" || run.status === "in_progress") {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      run = await project.agents.runs.get(thread.id, run.id);
    }
    if (run.status === "failed") {
      throw new Error(`Run failed: ${run.lastError}`);
    }
  }
  await pollRunStatus();
  const messages = await project.agents.messages.list(thread.id, {
    order: "asc",
  });
  // Use array iteration instead of for-await-of
  const messageArray = Array.from(messages);
  for (const m of messageArray) {
    const content = m.content.find((c) => c.type === "text" && "text" in c);
    if (content) {
      return content.text.value;
    }
  }
  throw new Error("No translated content returned by agent");
}

(async () => {
  try {
    const absPath = path.resolve(FILE_PATH);
    const fileContent = await fs.readFile(absPath, "utf8");
    const lines = fileContent.split("\n");
    // Remove first 3 and last 2 lines (wrappers)
    const contentLines = lines.slice(3, -2);
    // Filter out lines containing '//manually translated'
    const linesToTranslate = contentLines
      .filter((line) => !line.includes("//manually translated"))
      .join("\n");
    const translatedContent = await runAgentConversation(linesToTranslate);

    // Split translated content into key-value pairs
    const kvPairs = translatedContent
      .split(";|;")
      .map((pair) => pair.trim())
      .filter(Boolean);
    // Build a map of key-value updates
    const updates = new Map();
    kvPairs.forEach((pair) => {
      // Expect format: key = value
      const match = pair.match(/^([\w.-]+)\s*=\s*(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        updates.set(key, value);
      }
    });

    // Update the original content lines
    const updatedContentLines = contentLines.map((line) => {
      // Match key in line: "key": "value",
      const keyMatch = line.match(/^\s*"([\w.-]+)":\s*"(.*)",?$/);
      if (keyMatch) {
        const key = keyMatch[1];
        if (updates.has(key)) {
          const newValue = updates.get(key);
          // Preserve trailing comma if present
          const comma = line.endsWith(",") ? "," : "";
          return `  "${key}": "${newValue}"${comma}`;
        }
      }
      return line;
    });

    // Reconstruct the file with wrappers and updated content
    const newFileContent = [
      ...lines.slice(0, 3),
      ...updatedContentLines,
      ...lines.slice(-2),
    ].join("\n");
    await fs.writeFile(absPath, newFileContent, "utf8");
    console.log("File updated successfully.");
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
})();
