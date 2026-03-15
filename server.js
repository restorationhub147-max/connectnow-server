const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["https://zapchatapp.netlify.app", "http://localhost:3000", "http://127.0.0.1:5500"],
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
});

app.use(cors());
app.get("/", (req, res) => res.send("ZapChat Server Running ✅"));
app.get("/stats", (req, res) => {
  res.json({
    online: waitingUsers.length + activeRooms.size * 2,
    waiting: waitingUsers.length,
    activeRooms: activeRooms.size,
  });
});

// ─── State ───────────────────────────────────────────────────────────────────
let waitingUsers = [];
const activeRooms = new Map(); // roomId → { users: [socketIdA, socketIdB] }
const userRoom = new Map();    // socketId → roomId

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateRoomId() {
  return Math.random().toString(36).substring(2, 10);
}

function matchScore(a, b) {
  let score = 0;
  if (a.interests && b.interests) {
    const shared = a.interests.filter((i) => b.interests.includes(i));
    score += shared.length * 10;
  }
  if (a.country && b.country && a.country === b.country) score += 5;
  if (a.language && b.language && a.language === b.language) score += 8;
  return score;
}

function findBestMatch(user) {
  if (waitingUsers.length === 0) return null;
  let bestIndex = -1, bestScore = -1;
  for (let i = 0; i < waitingUsers.length; i++) {
    const c = waitingUsers[i];
    if (c.socketId === user.socketId) continue;
    const s = matchScore(user, c);
    if (s > bestScore) { bestScore = s; bestIndex = i; }
  }
  return bestIndex === -1 ? null : { user: waitingUsers[bestIndex], index: bestIndex };
}

function removeFromWaiting(socketId) {
  waitingUsers = waitingUsers.filter((u) => u.socketId !== socketId);
}

function leaveRoom(socketId) {
  const roomId = userRoom.get(socketId);
  if (!roomId) return;
  const room = activeRooms.get(roomId);
  if (room) {
    room.users.forEach((uid) => {
      if (uid !== socketId) {
        io.to(uid).emit("partner_left");
        userRoom.delete(uid);
      }
    });
    activeRooms.delete(roomId);
  }
  userRoom.delete(socketId);
}

function getOnlineCount() {
  return waitingUsers.length + activeRooms.size * 2;
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  io.emit("online_count", getOnlineCount() + 1);

  // ── Find Match ──────────────────────────────────────────────────────────────
  socket.on("find_match", (data) => {
    const user = {
      socketId: socket.id,
      interests: data.interests || [],
      country: data.country || "",
      language: data.language || "",
      gender: data.gender || "",
      mode: data.mode || "video",
      mood: data.mood || "",
    };

    removeFromWaiting(socket.id);
    // If already in a room, leave it first
    leaveRoom(socket.id);

    const match = findBestMatch(user);

    if (match) {
      waitingUsers.splice(match.index, 1);
      const roomId = generateRoomId();
      const partner = match.user;

      activeRooms.set(roomId, { users: [socket.id, partner.socketId] });
      userRoom.set(socket.id, roomId);
      userRoom.set(partner.socketId, roomId);

      const sharedInterests = user.interests.filter((i) =>
        partner.interests.includes(i)
      );

      // IMPORTANT: isInitiator=true for the NEWER user (socket)
      // The waiting user (partner) is the answerer
      socket.emit("match_found", {
        roomId,
        isInitiator: true,
        partnerId: partner.socketId,
        sharedInterests,
        partnerCountry: partner.country,
      });

      io.to(partner.socketId).emit("match_found", {
        roomId,
        isInitiator: false,
        partnerId: socket.id,
        sharedInterests,
        partnerCountry: user.country,
      });

      io.emit("online_count", getOnlineCount());
      console.log(`Matched: ${socket.id} ↔ ${partner.socketId} | Room: ${roomId}`);
    } else {
      waitingUsers.push(user);
      socket.emit("waiting", { position: waitingUsers.length });
      io.emit("online_count", getOnlineCount());
      console.log(`Waiting: ${socket.id} | Pool: ${waitingUsers.length}`);
    }
  });

  // ── WebRTC Signaling ─────────────────────────────────────────────────────────
  socket.on("webrtc_offer", ({ roomId, offer }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) {
      io.to(partner).emit("webrtc_offer", { offer });
      console.log(`Offer: ${socket.id} → ${partner}`);
    }
  });

  socket.on("webrtc_answer", ({ roomId, answer }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) {
      io.to(partner).emit("webrtc_answer", { answer });
      console.log(`Answer: ${socket.id} → ${partner}`);
    }
  });

  socket.on("webrtc_ice", ({ roomId, candidate }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("webrtc_ice", { candidate });
  });

  // ── Chat / Typing / Reactions ────────────────────────────────────────────────
  socket.on("chat_message", ({ roomId, message }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("chat_message", { message, timestamp: Date.now() });
  });

  socket.on("reaction", ({ roomId, emoji }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("reaction", { emoji });
  });

  socket.on("typing", ({ roomId, isTyping }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("typing", { isTyping });
  });

  // ── Profile Share ─────────────────────────────────────────────────────────────
  socket.on("share_profile", ({ roomId, profile }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("partner_profile", profile);
  });

  // ── Next / Skip ────────────────────────────────────────────────────────────────
  socket.on("next_stranger", () => {
    leaveRoom(socket.id);
    io.emit("online_count", getOnlineCount());
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log("Disconnected:", socket.id, "reason:", reason);
    removeFromWaiting(socket.id);
    leaveRoom(socket.id);
    io.emit("online_count", getOnlineCount());
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`ZapChat server running on port ${PORT}`);
});
