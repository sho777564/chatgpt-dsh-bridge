import { StringDecoder } from "node:string_decoder";

// Keep complete lines only. A discarded line stays discarded until its newline,
// so a suffix of an oversized record can never be accepted as a separate event.
export function createLineStream({ maxChars, onLine, onOverflow = () => {} }) {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let dropping = false;
  function consume(text) {
    let offset = 0;
    while (offset < text.length) {
      const end = text.indexOf("\n", offset);
      const stop = end < 0 ? text.length : end;
      if (!dropping) {
        if (partial.length + stop - offset > maxChars) {
          partial = "";
          dropping = true;
          onOverflow();
        } else {
          partial += text.slice(offset, stop);
        }
      }
      if (end < 0) return;
      if (!dropping) onLine(partial);
      partial = "";
      dropping = false;
      offset = end + 1;
    }
  }
  return {
    write: (chunk) => consume(decoder.write(chunk)),
    end() {
      consume(decoder.end());
      if (!dropping && partial) onLine(partial);
      partial = "";
    }
  };
}
