export default function handler(req, res) {
  res.status(200).json({ status: "ok", region: process.env.VERCEL_REGION || "unknown" });
}
