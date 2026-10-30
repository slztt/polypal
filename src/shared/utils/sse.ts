// Incremental Server-Sent Events parser for fetch() streams. Feed it decoded
// text chunks in arrival order; it returns the JSON payloads of every complete
// `data:` event, holding back a partial event until the rest arrives.

export class SseParser<T = unknown> {
  private buffer = ''

  feed(chunk: string): T[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const events: T[] = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n')
      if (data && data !== '[DONE]') {
        try {
          events.push(JSON.parse(data) as T)
        } catch {
          // A malformed event is skipped rather than aborting the stream.
        }
      }
      boundary = this.buffer.indexOf('\n\n')
    }
    return events
  }
}

/** Read an SSE response body, invoking `onEvent` for each parsed payload. */
export async function readSseStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser<T>()
  try {
    while (true) {
      if (signal?.aborted) break
      const { done, value } = await reader.read()
      if (done) break
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) onEvent(event)
    }
    for (const event of parser.feed(decoder.decode() + '\n\n')) onEvent(event)
  } finally {
    reader.releaseLock()
  }
}
