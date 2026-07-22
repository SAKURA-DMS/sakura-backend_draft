const crypto = require("crypto");
const bcrypt = require("bcrypt");

// OTP berlaku selama 1 menit.
// Nilai ini masih bisa dioverride melalui environment variable
// OTP_EXPIRY_MINUTES di Railway.
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 1);

const BCRYPT_ROUNDS = 10;

/**
 * Generate OTP 6 digit secara kriptografis aman.
 * @returns {string} OTP 6 digit, termasuk kemungkinan angka 0 di depan.
 */
function generateOtp() {
  const num = crypto.randomInt(0, 1_000_000);
  return String(num).padStart(6, "0");
}

/**
 * Hash OTP menggunakan bcrypt sebelum disimpan ke database.
 *
 * @param {string} otp - OTP plaintext 6 digit
 * @returns {Promise<string>} bcrypt hash
 */
async function hashOtp(otp) {
  return bcrypt.hash(otp, BCRYPT_ROUNDS);
}

/**
 * Verifikasi OTP yang dimasukkan user terhadap hash yang tersimpan.
 *
 * @param {string} otp - OTP plaintext yang diinput user
 * @param {string} otpHash - bcrypt hash dari database
 * @returns {Promise<boolean>}
 */
async function verifyOtp(otp, otpHash) {
  if (!otp || !otpHash) return false;

  return bcrypt.compare(String(otp), otpHash);
}

/**
 * Hitung waktu kedaluwarsa OTP.
 *
 * Default: 1 menit sejak OTP dibuat.
 *
 * @returns {Date} timestamp expires_at
 */
function getOtpExpiry() {
  const expiry = new Date();

  expiry.setTime(
    expiry.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000
  );

  return expiry;
}

/**
 * Cek apakah OTP sudah kedaluwarsa.
 *
 * @param {Date|string} expiresAt
 * @returns {boolean}
 */
function isOtpExpired(expiresAt) {
  if (!expiresAt) return true;

  const expiryTime = new Date(expiresAt).getTime();

  // Jika tanggal tidak valid, anggap OTP tidak valid/expired.
  if (Number.isNaN(expiryTime)) return true;

  return Date.now() >= expiryTime;
}

module.exports = {
  generateOtp,
  hashOtp,
  verifyOtp,
  getOtpExpiry,
  isOtpExpired,
  OTP_EXPIRY_MINUTES,
};