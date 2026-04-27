// Add this BEFORE anything else
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Extremely robust env loading
try {
  const envPath = path.resolve(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath });
    if (result.error) {
      console.error("❌ Dotenv Error:", result.error);
    } else {
      console.log("✅ .env loaded successfully from", envPath);
    }
  } else {
    // Fallback to root just in case
    const rootEnv = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(rootEnv)) {
      dotenv.config({ path: rootEnv });
      console.log("✅ .env loaded from root");
    } else {
      console.warn("⚠️ .env file not found");
    }
  }
} catch (e: any) {
  console.error("❌ Fatal Env Load Error:", e.message);
}

import express from "express";
//import { createServer as createViteServer } from "vite";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import multerStorageCloudinary from "multer-storage-cloudinary";

// Extract the constructor safely
const CloudinaryStorage =
  (multerStorageCloudinary as any).CloudinaryStorage || multerStorageCloudinary;
import Razorpay from "razorpay";
import admin from "firebase-admin";
import crypto from "crypto";

console.log("📝 Environment Variable Summary:");
console.log(
  "- RAZORPAY_KEY_ID:",
  process.env.RAZORPAY_KEY_ID
    ? `Present (${process.env.RAZORPAY_KEY_ID.substring(0, 4)}...)`
    : "MISSING ❌",
);
console.log(
  "- CLOUDINARY_CLOUD_NAME:",
  process.env.CLOUDINARY_CLOUD_NAME ? "Present ✅" : "MISSING ❌",
);

/* ================= FIREBASE ADMIN (FINAL FIX) ================= */

let firestore!: admin.firestore.Firestore;

try {
  if (!admin.apps.length) {
    const keyPath = path.resolve(__dirname, "firebase-key.json");
    console.log("🔑 Looking for Firebase key at:", keyPath);
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf-8"));

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("🔥 Firebase using JSON file");
  }

  firestore = admin.firestore();
  console.log("✅ Firestore initialized");
} catch (error: any) {
  console.error("❌ Firebase error:", error.message);
  // process.exit(1);
  console.error("⚠️ Server will continue running without Firebase");
}

/* ================= RAZORPAY ================= */

let razorpay: Razorpay | null = null;
function getRazorpay() {
  if (!razorpay) {
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;

    console.log(
      `[Razorpay] Checking keys... ID: ${key_id ? "YES" : "NO"}, Secret: ${key_secret ? "YES" : "NO"}`,
    );

    if (!key_id || !key_secret) {
      console.warn("⚠️ Razorpay keys missing. Payments will fail.");
      return null;
    }
    try {
      razorpay = new Razorpay({ key_id, key_secret });
      console.log("✅ Razorpay instance created successfully");
    } catch (e: any) {
      console.error("❌ Razorpay initialization error:", e.message);
      return null;
    }
  }
  return razorpay;
}

/* ================= CLOUDINARY ================= */

function configureCloudinary() {
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;

  console.log(
    `[Cloudinary] Configuring with Cloud Name: ${cloud_name || "MISSING"}, API Key: ${api_key ? "EXISTS" : "MISSING"}`,
  );

  if (!cloud_name || !api_key || !api_secret) {
    console.warn("⚠️ Cloudinary config missing. Uploads will fail.");
    return false;
  }

  cloudinary.config({ cloud_name, api_key, api_secret });
  console.log("✅ Cloudinary configured");
  return true;
}

configureCloudinary();

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "fixivo_docs",
    resource_type: "auto",
  } as any,
});

const upload = multer({ storage });

/* ================= SERVER ================= */

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  // app.use(cors());
  app.use(
  cors({
    origin: [
      "https://fixivo.vercel.app",
      "http://localhost:5173"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// VERY IMPORTANT (preflight fix)
app.options("*", cors());
  app.use(express.json());

  /* ================= SOCKET ================= */

  io.on("connection", (socket) => {
    socket.on("join-room", (roomId) => socket.join(roomId));
    socket.on("update-location", (data) => {
      io.to(data.bookingId).emit("location-updated", data);
    });
  });

  /* ================= HEALTH ================= */
  app.get("/", (req, res) => {
    res.send("Welcome to Fixvor API Server! 🚀");
  });
  app.get("/api/health", async (req, res) => {
    try {
      await firestore.collection("_test").doc("ping").get();
      res.json({ status: "ok", firestore: "connected" });
    } catch (e: any) {
      res.json({ status: "error", firestore: e.message });
    }
  });

  /* ================= USERS ================= */

  app.get("/api/admin/all-users", async (req, res) => {
    try {
      const snap = await firestore.collection("users").get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ================= PROMOTE ================= */

  app.post("/api/admin/promote-user", async (req, res) => {
    try {
      const { firebaseId, id, name } = req.body;
      const uid = firebaseId || id;

      if (!uid) return res.status(400).json({ error: "Missing ID" });

      await firestore
        .collection("users")
        .doc(uid)
        .set({ role: "worker" }, { merge: true });

      const workerRef = firestore.collection("workers").doc(uid);
      const workerDoc = await workerRef.get();

      const updateData: any = {
        uid: uid,
        createdAt: admin.firestore.Timestamp.now(),
      };

      if (name) updateData.name = name;
      if (!workerDoc.exists) {
        updateData.verified = false;
        updateData.verificationStatus = "pending";
      }

      await workerRef.set(updateData, { merge: true });

      res.json({ message: "Promoted to worker" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ================= WORKER ACTIONS ================= */

  app.post("/api/admin/approve-worker", async (req, res) => {
    try {
      const { workerId } = req.body;
      await firestore.collection("workers").doc(workerId).update({
        verified: true,
        verificationStatus: "approved",
        updatedAt: admin.firestore.Timestamp.now(),
      });
      res.json({ message: "Approved" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/unverify-worker", async (req, res) => {
    try {
      const { workerId, reason } = req.body;
      await firestore
        .collection("workers")
        .doc(workerId)
        .update({
          verified: false,
          verificationStatus: "correction_required",
          rejectionReason:
            reason || "Unverified by administrator for re-verification.",
          updatedAt: admin.firestore.Timestamp.now(),
        });
      res.json({ message: "Worker unverified and moved to re-verification" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/reject-worker", async (req, res) => {
    try {
      const { workerId, reason } = req.body;
      await firestore.collection("workers").doc(workerId).update({
        verified: false,
        verificationStatus: "rejected",
        rejectionReason: reason,
        updatedAt: admin.firestore.Timestamp.now(),
      });
      res.json({ message: "Rejected" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/request-correction", async (req, res) => {
    try {
      const { workerId, reason } = req.body;
      await firestore.collection("workers").doc(workerId).update({
        verified: false,
        verificationStatus: "correction_required",
        rejectionReason: reason,
        updatedAt: admin.firestore.Timestamp.now(),
      });
      res.json({ message: "Correction requested" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ================= SYNC ================= */

  app.post("/api/admin/sync-workers", async (req, res) => {
    try {
      const usersSnap = await firestore.collection("users").get();
      let created = 0;
      let synced = 0;

      for (const userDoc of usersSnap.docs) {
        const userData = userDoc.data();
        if (userData.role === "worker") {
          const workerRef = firestore.collection("workers").doc(userDoc.id);
          const workerDoc = await workerRef.get();

          if (!workerDoc.exists) {
            await workerRef.set({
              uid: userDoc.id,
              name: userData.name || "",
              verified: false,
              verificationStatus: "pending",
              createdAt: admin.firestore.Timestamp.now(),
            });
            created++;
          } else if (!workerDoc.data()?.uid) {
            await workerRef.update({ uid: userDoc.id });
            synced++;
          }
        }
      }

      res.json({
        message: `Sync complete. ${created} new profiles found, ${synced} updated.`,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /* ================= BOOKING ================= */

  // app.post("/api/bookings/create", async (req, res) => {
  //   const otp = Math.floor(1000 + Math.random() * 9000).toString();

  //   const ref = await firestore.collection("bookings").add({
  //     ...req.body,
  //     otpCode: otp,
  //     status: "pending",
  //     paymentStatus: "pending",
  //     createdAt: admin.firestore.Timestamp.now(),
  //   });

  //   res.json({ _id: ref.id, id: ref.id, otpCode: otp });
  // });
  app.post("/api/bookings/create", async (req, res) => {
  try {
    console.log("📦 Booking request:", req.body);

    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "Empty request body" });
    }

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const ref = await firestore.collection("bookings").add({
      ...req.body,
      otpCode: otp,
      status: "pending",
      paymentStatus: "pending",
      createdAt: admin.firestore.Timestamp.now(),
    });

    res.json({ _id: ref.id, id: ref.id, otpCode: otp });

  } catch (error: any) {
    console.error("❌ Booking Create Error:", error);
    res.status(500).json({ error: error.message });
  }
});

  /* ================= PAYMENT ================= */

  app.get("/api/payments/config", (req, res) => {
    const rzp = getRazorpay();
    res.json({ configured: !!rzp });
  });

  app.post("/api/payments/create-order", async (req, res) => {
    try {
      console.log(
        "[Payment API] Order request received. Checking Razorpay config...",
      );
      const rzp = getRazorpay();
      if (!rzp) {
        console.error(
          "[Payment API] ❌ ERROR: Razorpay instance is null. Missing keys in process.env?",
        );
        throw new Error(
          "Razorpay is not configured on the server. Check environment variables.",
        );
      }

      const order = await rzp.orders.create({
        amount: 9900,
        currency: "INR",
        receipt: `receipt_${Date.now()}`,
      });

      res.json({
        ...order,
        key_id: process.env.RAZORPAY_KEY_ID,
      });
    } catch (error: any) {
      console.error("Order Creation Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/payments/verify", async (req, res) => {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bookingId,
    } = req.body;

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment" });
    }

    await firestore.collection("bookings").doc(bookingId).update({
      paymentStatus: "paid",
      status: "confirmed",
    });

    res.json({ success: true });
  });

  /* ================= WORKER ================= */

  const memStorage = multer.memoryStorage();
  const memUpload = multer({
    storage: memStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
  }); // 5MB limit

  app.post(
    "/api/workers/register",
    memUpload.array("documents", 5),
    async (req: any, res) => {
      try {
        const { firebaseId, name, experience, skills } = req.body;
        const files = req.files as any[];

        if (!firebaseId)
          return res.status(400).json({ error: "Missing User ID" });

        console.log(
          `[Worker Register] 🛠️ Processing UID: ${firebaseId}, Files: ${files?.length || 0}`,
        );

        // Final sanity check for Cloudinary
        if (!cloudinary.config().api_key) {
          console.log(
            "[Worker Register] 🛠️ Re-configuring Cloudinary as keys were missing in current context...",
          );
          configureCloudinary();
        }

        const urlList: string[] = [];
        const errorLogs: string[] = [];

        if (files && files.length > 0) {
          console.log(
            `[Worker Register] 🚀 Starting upload for ${files.length} files...`,
          );
          for (const [idx, file] of files.entries()) {
            try {
              console.log(
                `[Worker Register] 📤 Uploading file ${idx + 1}/${files.length} (${file.originalname || "unknown"})...`,
              );
              const uploadPromise = new Promise<string>((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                  {
                    folder: "fixivo_docs",
                    resource_type: "auto",
                  },
                  (error, result) => {
                    if (error) {
                      console.error(
                        `[Worker Register] ❌ Cloudinary Stream Error (File ${idx + 1}):`,
                        error,
                      );
                      reject(error);
                    } else {
                      console.log(
                        `[Worker Register] ✅ Cloudinary Stream Success (File ${idx + 1})`,
                      );
                      resolve(result!.secure_url);
                    }
                  },
                );
                stream.end(file.buffer);
              });
              const url = await uploadPromise;
              urlList.push(url);
              console.log(
                `[Worker Register] ✅ Upload Finished (File ${idx + 1}): ${url}`,
              );
            } catch (err: any) {
              const errMsg = err.message || JSON.stringify(err);
              console.error(
                `[Worker Register] ❌ Individual file upload error (${idx + 1}):`,
                errMsg,
              );
              errorLogs.push(
                `File ${idx + 1} (${file.originalname}): ${errMsg}`,
              );
            }
          }
        }

        console.log(
          `[Worker Register] 📎 Final URL List count: ${urlList.length}`,
        );

        const expNum = parseInt(experience?.toString() || "0");
        const workerData: any = {
          uid: firebaseId,
          name: name || "",
          phone: req.body.phone || "",
          experience: isNaN(expNum) ? 0 : expNum,
          skills:
            skills && typeof skills === "string"
              ? JSON.parse(skills)
              : Array.isArray(skills)
                ? skills
                : [],
          verificationStatus: "pending",
          bankAccountName: req.body.bankAccountName || "",
          bankAccountNumber: req.body.bankAccountNumber || "",
          bankIFSC: req.body.bankIFSC || "",
          bankName: req.body.bankName || "",
          updatedAt: admin.firestore.Timestamp.now(),
          backend_synced: true,
          files_count: files?.length || 0,
          upload_errors: errorLogs.length > 0 ? errorLogs : null,
        };

        if (urlList.length > 0) {
          workerData.documents = admin.firestore.FieldValue.arrayUnion(
            ...urlList,
          );
          // Only set unverified if it's a significant update
          if (name || experience || skills) {
            workerData.verified = false;
          }
        }

        console.log(
          `[Worker Register] 💾 Write attempt for UID: ${firebaseId}, Docs: ${urlList.length}`,
        );

        await firestore
          .collection("workers")
          .doc(firebaseId)
          .set(
            {
              ...workerData,
              backend_upload_log: `Seen ${files?.length || 0} files. Succeeded: ${urlList.length}. Errors: ${errorLogs.length}.`,
              last_backend_run: admin.firestore.Timestamp.now(),
            },
            { merge: true },
          );

        await firestore.collection("users").doc(firebaseId).set(
          {
            name: workerData.name,
            role: "worker",
          },
          { merge: true },
        );

        res.json({
          message: "Registration updated",
          saved_docs: urlList.length,
          uid: firebaseId,
        });
      } catch (error: any) {
        console.error("[Worker Register] ❌ Global Error:", error);
        res.status(500).json({ error: error.message });
      }
    },
  );

  app.post(
    "/api/utils/upload",
    memUpload.single("file"),
    async (req: any, res) => {
      try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });

        const uploadPromise = new Promise<string>((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: "fixivo_uploads",
              resource_type: "auto",
            },
            (error, result) => {
              if (error) reject(error);
              else resolve(result!.secure_url);
            },
          );
          stream.end(file.buffer);
        });

        const url = await uploadPromise;
        res.json({ url });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    },
  );

  /* ================= COMPLETE ================= */

  app.post("/api/bookings/complete", async (req, res) => {
    const { bookingId, otpCode, isForce, billDetails } = req.body;

    const ref = firestore.collection("bookings").doc(bookingId);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (!isForce && doc.data()?.otpCode !== otpCode) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const updateData: any = {
      status: "completed",
      completedAt: admin.firestore.Timestamp.now(),
    };

    if (billDetails) {
      updateData.billDetails = billDetails;
    }

    await ref.update(updateData);

    // Update worker stats (Innovation: Gamification)
    const bookingData = doc.data();
    if (bookingData?.workerId) {
      const workerRef = firestore
        .collection("workers")
        .doc(bookingData.workerId);
      await workerRef.update({
        jobsCompleted: admin.firestore.FieldValue.increment(1),
        leaderboardScore: admin.firestore.FieldValue.increment(100), // 100 points per job
      });
    }

    res.json({ message: "Done" });
  });

  /* ================= ASSIGN ================= */

  app.post("/api/bookings/assign", async (req, res) => {
    const { bookingId, workerId } = req.body;
    const ref = firestore.collection("bookings").doc(bookingId);
    const doc = await ref.get();

    if (doc.exists && doc.data()?.workerId) {
      return res
        .status(400)
        .json({ error: "Job already accepted by another worker" });
    }

    const workerSnap = await firestore
      .collection("workers")
      .doc(workerId)
      .get();
    const workerData = workerSnap.data();

    await ref.update({
      workerId,
      workerName: workerData?.name || "Expert",
      workerPhone: workerData?.phone || "",
      status: "assigned",
      assignedAt: admin.firestore.Timestamp.now(),
    });

    res.json({ message: "Assigned" });
  });

  /* ================= REWARDS ================= */

  app.post("/api/admin/give-reward", async (req, res) => {
    try {
      const { workerId, amount, reason, workerName } = req.body;
      console.log(
        `[Admin API] Give Reward: workerId=${workerId}, amount=${amount}, reason=${reason}`,
      );

      if (!workerId || !amount) {
        return res
          .status(400)
          .json({ error: "Worker ID and Amount are required" });
      }

      const rewardData = {
        workerId,
        workerName: workerName || "Worker",
        amount: parseFloat(amount),
        reason: reason || "Performance Bonus",
        date: new Date().toISOString(),
        createdAt: admin.firestore.Timestamp.now(),
      };

      // 1. Save to reward history
      const rewardRef = await firestore
        .collection("reward_history")
        .add(rewardData);
      console.log(`[Admin API] Reward saved with ID: ${rewardRef.id}`);

      // 2. Increment worker's leaderboard score
      await firestore
        .collection("workers")
        .doc(workerId)
        .update({
          leaderboardScore: admin.firestore.FieldValue.increment(100),
        });
      console.log(`[Admin API] Worker ${workerId} score incremented`);

      res.json({
        success: true,
        message: "Reward processed successfully",
        rewardId: rewardRef.id,
      });
    } catch (error: any) {
      console.error("[Admin API] Reward Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  /* ================= VITE ================= */
  // const frontendPath = path.resolve(__dirname, "../frontend");

  // if (process.env.NODE_ENV !== "production") {
  //   console.log(
  //     `🛠️ Starting server in DEVELOPMENT mode with Vite middleware (root: ${frontendPath})`,
  //   );
  //   const vite = await createViteServer({
  //     root: frontendPath,
  //     server: { middlewareMode: true },
  //     appType: "spa",
  //   });
  //   app.use(vite.middlewares);
  // } else {
  //   console.log(
  //     `📦 Starting server in PRODUCTION mode serving from ${frontendPath}/dist/`,
  //   );
  //   const dist = path.join(frontendPath, "dist");
  //   if (!fs.existsSync(dist)) {
  //     console.warn(
  //       "⚠️ WARNING: 'dist' directory not found! Ensure 'npm run build' was executed.",
  //     );
  //   }
  //   app.use(express.static(dist));
  //   app.get("*", (_, res) => res.sendFile(path.join(dist, "index.html")));
  // }

  // httpServer.listen(3000, () => {
  //   console.log("🚀 Server running on :localhost000");
  // });
  const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
}

startServer();
