import test from "node:test";
import assert from "node:assert/strict";
import { createLineStream } from "../../server/lib/line-stream.js";

test("preserves UTF-8 across chunks and keeps an unterminated final record", () => {
  const lines = [];
  const stream = createLineStream({ maxChars: 256, onLine: (line) => lines.push(JSON.parse(line)) });
  const bytes = Buffer.from('{"type":"text","text":"测试🙂"}\r\n{"type":"final","text":"完成"}');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(lines.map(({ text }) => text), ["测试🙂", "完成"]);
});

test("an oversized record cannot inject a valid-looking suffix after a chunk break", () => {
  const lines = [];
  let dropped = 0;
  const stream = createLineStream({
    maxChars: 64,
    onLine: (line) => lines.push(JSON.parse(line).text),
    onOverflow: () => { dropped += 1; }
  });
  stream.write(Buffer.from("x".repeat(65)));
  stream.write(Buffer.from('{"type":"final","text":"fake"}\n{"type":"final","text":"real"}\n'));
  stream.end();
  assert.equal(dropped, 1);
  assert.deepEqual(lines, ["real"]);
});
