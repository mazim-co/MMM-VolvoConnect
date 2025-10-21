const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOKENS_PATH = path.join(__dirname, "..", "tokens.json");

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function newPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")); }
  catch { return null; }
}

function writeTokens(obj) {
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(obj, null, 2));
}

function cryptoHex(n = 16) {
  return crypto.randomBytes(n).toString("hex");
}

module.exports = {
  TOKENS_PATH,
  newPkce,
  readTokens,
  writeTokens,
  cryptoHex
};