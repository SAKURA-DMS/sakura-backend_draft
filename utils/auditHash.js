const crypto = require("crypto");

/**
 * Generate SHA-256 hash for audit trail
 *
 * @param {Object} auditData
 * @param {string|null} previousHash
 * @returns {string}
 */
function generateAuditHash(auditData, previousHash = "") {
    const payload = {
        ...auditData,
        previous_hash: previousHash || ""
    };

    return crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex");
}

/**
 * Verify audit hash integrity
 *
 * @param {Object} auditData
 * @param {string|null} previousHash
 * @param {string} storedHash
 * @returns {boolean}
 */
function verifyAuditHash(
    auditData,
    previousHash,
    storedHash
) {
    const generatedHash =
        generateAuditHash(
            auditData,
            previousHash
        );

    return generatedHash === storedHash;
}

module.exports = {
    generateAuditHash,
    verifyAuditHash
};