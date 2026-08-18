const crypto = require("crypto");
const bcrypt = require("bcrypt");

const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 1);

const BCRYPT_ROUNDS = 10;

/**
 * @returns {string} 
 */
function generateOtp() {
  const num = crypto.randomInt(0, 1_000_000);
  return String(num).padStart(6, "0");
}

/**
 * Hash the OTP using bcrypt before storing it in the database
 *
 * @param {string} otp 
 * @returns {Promise<string>}
 */
async function hashOtp(otp) {
  return bcrypt.hash(otp, BCRYPT_ROUNDS);
}

/**
 * Verify the OTP entered by the user against the stored hash
 *
 * @param {string} otp 
 * @param {string} otpHash 
 * @returns {Promise<boolean>}
 */
async function verifyOtp(otp, otpHash) {
  if (!otp || !otpHash) return false;

  return bcrypt.compare(String(otp), otpHash);
}

/**
 * Measure the OTP expiry time
 *
 * Default: 1 minute after the OTP is generated
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
 * Check if the OTP has expired based on the expiresAt timestamp.
 *
 * @param {Date|string} expiresAt
 * @returns {boolean}
 */
function isOtpExpired(expiresAt) {
  if (!expiresAt) return true;

  const expiryTime = new Date(expiresAt).getTime();

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