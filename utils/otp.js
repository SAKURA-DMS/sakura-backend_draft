const crypto = require("crypto");
const bcrypt = require("bcrypt");

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 5);
const BCRYPT_ROUNDS       = 10;

/**
 * Generate OTP 6 digit secara kriptografis aman.
 * @returns {string} "000000"–"999999" (selalu 6 karakter, zero-padded)
 */
function generateOtp() {
  // crypto.randomInt(0, 1_000_000) → integer [0, 999999]
  const num = crypto.randomInt(0, 1_000_000);
  return String(num).padStart(6, "0");
}

/**
 * Hash OTP menggunakan bcrypt.
 * @param {string} otp - OTP plaintext 6 digit
 * @returns {Promise<string>} bcrypt hash
 */
async function hashOtp(otp) {
  return bcrypt.hash(otp, BCRYPT_ROUNDS);
}

/**
 * Verifikasi OTP plaintext terhadap bcrypt hash.
 * @param {string} otp     - OTP plaintext yang diinput user
 * @param {string} otpHash - bcrypt hash dari DB
 * @returns {Promise<boolean>}
 */
async function verifyOtp(otp, otpHash) {
  return bcrypt.compare(otp, otpHash);
}

/**
 * Hitung waktu kedaluwarsa OTP.
 * @returns {Date} timestamp expires_at
 */
function getOtpExpiry() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + OTP_EXPIRY_MINUTES);
  return d;
}

/**
 * Cek apakah OTP sudah kedaluwarsa.
 * @param {Date|string} expiresAt
 * @returns {boolean}
 */
function isOtpExpired(expiresAt) {
  return new Date() > new Date(expiresAt);
}

module.exports = {
  generateOtp,
  hashOtp,
  verifyOtp,
  getOtpExpiry,
  isOtpExpired,
  OTP_EXPIRY_MINUTES,
};