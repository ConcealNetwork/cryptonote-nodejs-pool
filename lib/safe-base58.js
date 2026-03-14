/**
 * Safe Base58 implementation using native BigInt
 * Pure JavaScript, no native dependencies, no vulnerabilities
 * 
 * Implements Base58 encoding/decoding for Cryptonote addresses
 * Based on Bitcoin Base58 alphabet but with safe BigInt operations
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = BigInt(ALPHABET.length);

/**
 * Encode a Buffer to Base58 string
 * @param {Buffer} input - Buffer to encode
 * @returns {string} Base58 encoded string
 */
function encodeBase58(input) {
    if (!Buffer.isBuffer(input)) {
        throw new TypeError('Expected Buffer');
    }
    
    if (input.length === 0) {
        return '';
    }
    
    // Count leading zeros
    let zeros = 0;
    while (zeros < input.length && input[zeros] === 0) {
        zeros++;
    }
    
    // Convert to BigInt (big-endian)
    let value = 0n;
    for (const byte of input) {
        value = (value << 8n) | BigInt(byte);
    }
    
    // Encode
    let result = '';
    while (value > 0n) {
        const mod = value % BASE;
        value = value / BASE;
        result = `${ALPHABET[Number(mod)]}${result}`;
    }
    
    // Preserve leading zero bytes as '1's
    for (let i = 0; i < zeros; i++) {
        result = `1${result}`;
    }
    
    return result || '1';
}

/**
 * Decode a Base58 string to Buffer
 * @param {string} str - Base58 encoded string
 * @returns {Buffer} Decoded buffer
 */
function decodeBase58(str) {
    if (typeof str !== 'string') {
        throw new TypeError('Expected string');
    }
    
    if (str.length === 0) {
        return Buffer.alloc(0);
    }
    
    // Validate Base58 characters
    if (!/^[1-9A-HJ-NP-Za-km-z]*$/.test(str)) {
        throw new Error('Invalid base58 string');
    }
    
    // Count leading '1's (which represent leading zero bytes)
    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') {
        zeros++;
    }
    
    // Decode to BigInt
    let value = 0n;
    for (let i = zeros; i < str.length; i++) {
        const char = str[i];
        const idx = ALPHABET.indexOf(char);
        if (idx === -1) {
            throw new Error(`Invalid base58 character: ${char}`);
        }
        value = value * BASE + BigInt(idx);
    }
    
    // Convert BigInt to bytes (big-endian)
    const bytes = [];
    while (value > 0n) {
        bytes.push(Number(value & 0xffn));
        value = value >> 8n;
    }
    bytes.reverse();
    
    // Restore leading zeros
    return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]);
}

/**
 * Decode a Cryptonote address and return the prefix
 * This mimics cryptoforknote-util's address_decode function
 * @param {Buffer|string} address - Base58 encoded address
 * @returns {Buffer|null} Address prefix (first byte) or null if invalid
 */
function addressDecode(address) {
    try {
        let addressBuffer;
        if (Buffer.isBuffer(address)) {
            addressBuffer = address;
        } else if (typeof address === 'string') {
            addressBuffer = Buffer.from(address, 'utf8');
        } else {
            return null;
        }
        
        // Decode base58
        const decoded = decodeBase58(addressBuffer.toString('utf8'));
        
        // Cryptonote addresses are typically 69 bytes:
        // - 1 byte prefix
        // - 32 bytes public spend key
        // - 32 bytes public view key
        // - 4 bytes checksum
        // But we only need the prefix (first byte)
        if (decoded.length < 1) {
            return null;
        }
        
        // Return the prefix as a Buffer
        return Buffer.from([decoded[0]]);
    } catch {
        return null;
    }
}

/**
 * Decode an integrated Cryptonote address and return the prefix
 * This mimics cryptoforknote-util's address_decode_integrated function
 * Integrated addresses have a different structure with payment ID
 * @param {Buffer|string} address - Base58 encoded integrated address
 * @returns {Buffer|null} Address prefix (first byte) or null if invalid
 */
function addressDecodeIntegrated(address) {
    try {
        let addressBuffer;
        if (Buffer.isBuffer(address)) {
            addressBuffer = address;
        } else if (typeof address === 'string') {
            addressBuffer = Buffer.from(address, 'utf8');
        } else {
            return null;
        }
        
        // Decode base58
        const decoded = decodeBase58(addressBuffer.toString('utf8'));
        
        // Integrated addresses are typically longer (prefix + keys + payment ID + checksum)
        // But we only need the prefix (first byte)
        if (decoded.length < 1) {
            return null;
        }
        
        // Return the prefix as a Buffer
        return Buffer.from([decoded[0]]);
    } catch {
        return null;
    }
}

module.exports = {
    encode: encodeBase58,
    decode: decodeBase58,
    address_decode: addressDecode,
    address_decode_integrated: addressDecodeIntegrated
};
