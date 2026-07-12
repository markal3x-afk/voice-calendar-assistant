import crypto from "crypto";

// Derives a 32-byte key from any ENCRYPTION_KEY string using SHA-256
const getEncryptionKey = () => {
  const secret = process.env.ENCRYPTION_KEY || "temporary-dev-encryption-key-shhh";
  return crypto.createHash("sha256").update(secret).digest();
};

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM mode recommendation

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * @param {string} text Plaintext to encrypt
 * @returns {string} Encrypted bundle formatted as iv:authTag:cipherText
 */
export function encrypt(text) {
  if (!text) return null;
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag().toString("hex");
  
  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted bundle.
 * @param {string} encryptedText Encrypted bundle formatted as iv:authTag:cipherText
 * @returns {string|null} Decrypted plaintext string or null if decryption fails
 */
export function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const key = getEncryptionKey();
    const parts = encryptedText.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted bundle layout. Expected 3 colon-separated hex strings.");
    }
    
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encrypted = parts[2];
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    
    return decrypted;
  } catch (err) {
    console.error("AES decryption failure:", err.message);
    return null;
  }
}
