import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const backend = await readFile(new URL("../functions/api/music.js", import.meta.url), "utf8");
const frontend = await readFile(new URL("../app.js", import.meta.url), "utf8");

assert.match(backend, /single-master-v4-async/, "preview must support one full master through an async ACE task");
assert.match(backend, /\/v1\/chat\/completions/, "ACE cloud mode must use the documented OpenRouter-compatible endpoint");
assert.match(backend, /\/release_task/, "self-hosted ACE mode must submit native async tasks");
assert.match(backend, /\/query_result/, "self-hosted ACE mode must poll native task status");
assert.match(backend, /ACEMUSIC_API_MODE/, "cloud and self-hosted API modes must be explicit");
assert.match(backend, /\/v1\/music_generation/, "MiniMax mode must use the official music generation endpoint");
assert.match(backend, /music-2\.6-free/, "MiniMax free music model must be selectable as the default model");
assert.match(backend, /single-master-minimax-v1/, "MiniMax preview and unlock must share one complete master");
assert.match(backend, /\/generations\/status\//, "Treblo mode must poll the official generation status endpoint");
assert.match(backend, /single-master-treblo-v3/, "Treblo preview and unlock must share one complete master");
assert.match(backend, /align_lyrics:\s*true/, "Treblo generation must request word-level lyric alignment");
assert.match(backend, /lyrics:\s*clean\(payload\.lyrics,\s*2400\)/, "preview must submit the complete lyrics");
assert.match(backend, /fullSongPreview:\s*true/, "preview must expose the complete song for lyric review");
assert.match(backend, /temporary-full-song/, "full preview responses must be explicitly marked as temporary");
assert.doesNotMatch(backend, /put\(previewObjectKey\(manifest\.jobId\),\s*clipped\.bytes/, "full-song preview must not duplicate a clipped audio object");
assert.doesNotMatch(backend, /taskType:\s*"complete"/, "unlock must not ask ACE to invent a continuation");
assert.doesNotMatch(backend, /concatAudio\s*\(/, "unlock must not concatenate MP3 files");
assert.match(backend, /providerAlignment\(/, "real provider timestamps must be consumed when available");
assert.match(backend, /alignmentStatus:\s*manifest\.alignment\s*\?\s*"verified"\s*:\s*"unavailable"/, "alignment state must be explicit");

assert.doesNotMatch(frontend, /function buildScoreAlignment\s*\(/, "the UI must not fabricate timestamps from the planned score");
assert.match(frontend, /estimated:\s*true/, "lyrics without provider timestamps need a clearly marked estimated line timeline");
assert.match(frontend, /!line\.estimated/, "estimated lines must never pretend to have word-level timing");
assert.match(frontend, /估算逐行同步/, "the UI must disclose estimated synchronization");

console.log("PASS single-master and real-alignment contracts");
