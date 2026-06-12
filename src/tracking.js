const HEX_WIDTH = 2;

function toHex(byte) {
  return byte.toString(16).toUpperCase().padStart(HEX_WIDTH, '0');
}

export function calculateChecksum(matrixCode) {
  const bits = [];

  for (const character of matrixCode.toUpperCase()) {
    const binary = character.charCodeAt(0).toString(2).padStart(8, '0');
    bits.push(...binary);
  }

  const crc = [0, 0, 0, 0];

  while (bits.length > 0) {
    const bit = bits.shift() === '1' ? 1 : 0;
    const doInvert = bit ^ crc[3];

    crc[3] = crc[2];
    crc[2] = crc[1];
    crc[1] = crc[0] ^ doInvert;
    crc[0] = doInvert;
  }

  return (crc[3] * 8 + crc[2] * 4 + crc[1] * 2 + crc[0]).toString(16).toUpperCase();
}

export function getPrefixFromText(decodedText) {
  if (!decodedText || decodedText.length < 3) {
    return '';
  }
  return decodedText.substring(0, 3).toUpperCase();
}

export function decodeTrackingNumber(decodedText, rawBytes, configuredPrefix = 'DEA') {
  // Validate inputs
  if (!decodedText || typeof decodedText !== 'string') {
    throw new Error('Der gelesene Datamatrix-Code enthält keinen Text.');
  }

  if (!(rawBytes instanceof Uint8Array) || rawBytes.length < 16) {
    throw new Error('Der gelesene Datamatrix-Code ist zu kurz.');
  }

  // Check prefix from decoded text
  const expectedPrefix = configuredPrefix.trim().toUpperCase();
  const actualPrefix = getPrefixFromText(decodedText);

  if (expectedPrefix && actualPrefix !== expectedPrefix) {
    const error = new Error(`Ungültiger Datamatrix-Präfix: erwartet ${expectedPrefix}, gefunden ${actualPrefix || 'leer'}.`);
    error.name = 'InvalidPrefixError';
    throw error;
  }

  // Extract tracking number from raw bytes
  const trackingBase = [
    ...Array.from(rawBytes.slice(11, 16), toHex),
    (rawBytes[6] & 0x0f).toString(16).toUpperCase(),
    ...Array.from(rawBytes.slice(7, 11), toHex),
  ].join('');

  return `${trackingBase}${calculateChecksum(trackingBase)}`;
}

export function formatRawBytes(rawBytes) {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length === 0) {
    return 'Keine Rohdaten verfügbar.';
  }

  const hex = Array.from(rawBytes, toHex).join(' ');
  const ascii = Array.from(rawBytes, (byte) => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.')).join('');

  return `Hex:\n${hex}\n\nASCII:\n${ascii}`;
}
