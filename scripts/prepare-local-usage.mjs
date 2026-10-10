import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const manifest = JSON.parse(
  await readFile(new URL("./local-usage-engine.json", import.meta.url), "utf8"),
);
const directory = new URL(
  "../src-tauri/resources/local-usage/",
  import.meta.url,
);
const target = new URL("tokscale.exe", directory);
const hash = (data) => createHash("sha256").update(data).digest("hex");
let present;
try {
  present = await readFile(target);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!present || hash(present) !== manifest.sha256) {
  const url = `https://github.com/${manifest.repository}/releases/download/${manifest.release}/${manifest.asset}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok)
    throw new Error(`Engine download failed: ${response.status}`);
  const limit = 50 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("Engine asset exceeds size limit");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) {
      throw new Error("Engine asset exceeds size limit");
    }
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  if (hash(data) !== manifest.sha256)
    throw new Error("Engine checksum mismatch; asset was not installed");
  await mkdir(directory, { recursive: true });
  const temporary = new URL("tokscale.exe.tmp", directory);
  await writeFile(temporary, data);
  await rename(temporary, target);
}
console.log(
  `Local usage engine verified: ${manifest.commit.slice(0, 8)} (${fileURLToPath(target)})`,
);
