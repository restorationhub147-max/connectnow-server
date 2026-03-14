const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["https://zapchatapp.netlify.app", "http://localhost:3000"],
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.get("/", (req, res) => res.send("ConnectNow Server Running ✅"));
app.get("/stats", (req, res) => {
  res.json({
    online: waitingUsers.length + activeRooms.size * 2,
    waiting: waitingUsers.length,
    activeRooms: activeRooms.size,
  });
});

// ─── State ────────────────────────────────────────────────────────────────────

// waitingUsers: array of { socketId, interests[], country, language, gender }
let waitingUsers = [];

// activeRooms: Map<roomId, { users: [socketIdA, socketIdB] }>
const activeRooms = new Map();

// userRoom: Map<socketId, roomId>
const userRoom = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRoomId() {
  return Math.random().toString(36).substring(2, 10);
}

// Score how well two users match (higher = better)
function matchScore(a, b) {
  let score = 0;
  // Shared interests — each match +10
  if (a.interests && b.interests) {
    const shared = a.interests.filter((i) => b.interests.includes(i));
    score += shared.length * 10;
  }
  // Same country +5
  if (a.country && b.country && a.country === b.country) score += 5;
  // Same language +8
  if (a.language && b.language && a.language === b.language) score += 8;
  // Gender preference +3
  if (a.gender && b.gender && a.gender !== b.gender) score += 3;
  return score;
}

// Find best match for a user from the waiting pool
function findBestMatch(user) {
  if (waitingUsers.length === 0) return null;

  let bestIndex = -1;
  let bestScore = -1;

  for (let i = 0; i < waitingUsers.length; i++) {
    const candidate = waitingUsers[i];
    if (candidate.socketId === user.socketId) continue;
    const score = matchScore(user, candidate);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) return null;
  return { user: waitingUsers[bestIndex], index: bestIndex };
}

function removeFromWaiting(socketId) {
  waitingUsers = waitingUsers.filter((u) => u.socketId !== socketId);
}

function leaveRoom(socketId) {
  const roomId = userRoom.get(socketId);
  if (!roomId) return;

  const room = activeRooms.get(roomId);
  if (room) {
    // Notify the other user
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

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Broadcast updated online count
  io.emit("online_count", waitingUsers.length + activeRooms.size * 2 + 1);

  // ── Find Match ──────────────────────────────────────────────────────────────
  socket.on("find_match", (data) => {
    // data: { interests[], country, language, gender, mode }
    const user = {
      socketId: socket.id,
      interests: data.interests || [],
      country: data.country || "",
      language: data.language || "",
      gender: data.gender || "",
      mode: data.mode || "video",
    };

    // Don't double-add
    removeFromWaiting(socket.id);

    const match = findBestMatch(user);

    if (match) {
      // Remove matched user from waiting pool
      waitingUsers.splice(match.index, 1);

      const roomId = generateRoomId();
      const partner = match.user;

      // Create room
      activeRooms.set(roomId, { users: [socket.id, partner.socketId] });
      userRoom.set(socket.id, roomId);
      userRoom.set(partner.socketId, roomId);

      // Calculate shared interests
      const sharedInterests = user.interests.filter((i) =>
        partner.interests.includes(i)
      );

      // Notify both users — one is "initiator" (makes WebRTC offer)
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

      console.log(
        `Matched: ${socket.id} ↔ ${partner.socketId} | Room: ${roomId} | Shared: ${sharedInterests}`
      );
    } else {
      // No match yet — add to waiting pool
      waitingUsers.push(user);
      socket.emit("waiting", { position: waitingUsers.length });
      console.log(`Waiting: ${socket.id} | Pool size: ${waitingUsers.length}`);
    }
  });

  // ── WebRTC Signaling ─────────────────────────────────────────────────────────
  // Relay WebRTC offer/answer/ICE to the partner in the same room

  socket.on("webrtc_offer", ({ roomId, offer }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("webrtc_offer", { offer });
  });

  socket.on("webrtc_answer", ({ roomId, answer }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("webrtc_answer", { answer });
  });

  socket.on("webrtc_ice", ({ roomId, candidate }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("webrtc_ice", { candidate });
  });

  // ── Chat Messages ─────────────────────────────────────────────────────────────
  socket.on("chat_message", ({ roomId, message }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) {
      io.to(partner).emit("chat_message", {
        message,
        timestamp: Date.now(),
      });
    }
  });

  // ── Reactions ─────────────────────────────────────────────────────────────────
  socket.on("reaction", ({ roomId, emoji }) => {
    const room = activeRooms.get(roomId);
    if (!room) return;
    const partner = room.users.find((id) => id !== socket.id);
    if (partner) io.to(partner).emit("reaction", { emoji });
  });

  // ── Skip / Next ───────────────────────────────────────────────────────────────
  socket.on("next_stranger", () => {
    leaveRoom(socket.id);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    removeFromWaiting(socket.id);
    leaveRoom(socket.id);
    io.emit("online_count", waitingUsers.length + activeRooms.size * 2);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`ConnectNow server running on port ${PORT}`);
});
