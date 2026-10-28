/** Overwrite a key buffer with zeros (best effort; JS cannot guarantee no copies exist). */
export function memzero(buffer: Uint8Array): void {
  buffer.fill(0);
}

/** Zero every given buffer; null/undefined entries are skipped. Call on lock. */
export function wipe(...buffers: ReadonlyArray<Uint8Array | null | undefined>): void {
  for (const buffer of buffers) {
    if (buffer) memzero(buffer);
  }
}
