import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const PORT = Number(process.env.PORT) || 3000;

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Track room state in memory
  const rooms = new Map<string, {
    participants: Map<string, { id: string; name: string; isHost: boolean; isMuted: boolean; isVideoOff: boolean; isScreenSharing: boolean }>;
    isLocked: boolean;
    spotlightId: string | null;
  }>();

  io.on("connection", (socket) => {
    console.log("New user connected:", socket.id);

    socket.on("join-room", ({ roomId, name }: { roomId: string; name: string }) => {
      let room = rooms.get(roomId);

      if (room?.isLocked) {
        socket.emit("error", { message: "This room is locked." });
        return;
      }

      if (!room) {
        room = {
          participants: new Map(),
          isLocked: false,
          spotlightId: null,
        };
        rooms.set(roomId, room);
      }

      const isHost = room.participants.size === 0;
      const userData = {
        id: socket.id,
        name: name || `User ${socket.id.slice(0, 4)}`,
        isHost,
        isMuted: false,
        isVideoOff: false,
        isScreenSharing: false,
      };

      room.participants.set(socket.id, userData);
      socket.join(roomId);

      // Tell the user they've joined and who else is there
      const participants = Array.from(room.participants.values());
      socket.emit("room-joined", { 
        roomId, 
        me: userData, 
        participants: participants.filter(p => p.id !== socket.id),
        isLocked: room.isLocked,
        spotlightId: room.spotlightId 
      });

      // Notify others
      socket.to(roomId).emit("user-joined", userData);
    });

    socket.on("signal", ({ to, from, signal }: { to: string; from: string; signal: any }) => {
      io.to(to).emit("signal", { from, signal });
    });

    socket.on("update-state", ({ roomId, state }: { roomId: string; state: any }) => {
      const room = rooms.get(roomId);
      if (room) {
        const user = room.participants.get(socket.id);
        if (user) {
          Object.assign(user, state);
          io.to(roomId).emit("user-updated", user);
        }
      }
    });

    socket.on("send-message", ({ roomId, text }: { roomId: string; text: string }) => {
      const room = rooms.get(roomId);
      if (room) {
        const user = room.participants.get(socket.id);
        if (user) {
          const message = {
            id: Math.random().toString(36).substr(2, 9),
            senderId: socket.id,
            senderName: user.name,
            text,
            timestamp: Date.now(),
          };
          io.to(roomId).emit("new-message", message);
        }
      }
    });

    // Host Controls
    socket.on("mute-all", ({ roomId }: { roomId: string }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        io.to(roomId).emit("force-mute-all");
      }
    });

    socket.on("mute-user", ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        io.to(userId).emit("force-mute");
      }
    });

    socket.on("stop-video-user", ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        io.to(userId).emit("force-stop-video");
      }
    });

    socket.on("promote-host", ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        const target = room.participants.get(userId);
        if (target) {
          // Add to current requester that they are no longer host
          requester.isHost = false;
          io.to(roomId).emit("user-updated", requester);
          
          // Promote target
          target.isHost = true;
          io.to(roomId).emit("user-updated", target);
        }
      }
    });

    socket.on("kick-user", ({ roomId, userId }: { roomId: string; userId: string }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        io.to(userId).emit("kicked");
        const userSocket = io.sockets.sockets.get(userId);
        userSocket?.leave(roomId);
        room.participants.delete(userId);
        io.to(roomId).emit("user-left", userId);
      }
    });

    socket.on("lock-room", ({ roomId, locked }: { roomId: string; locked: boolean }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        room.isLocked = locked;
        io.to(roomId).emit("room-locked", locked);
      }
    });

    socket.on("spotlight-user", ({ roomId, userId }: { roomId: string; userId: string | null }) => {
      const room = rooms.get(roomId);
      const requester = room?.participants.get(socket.id);
      if (requester?.isHost) {
        room.spotlightId = userId;
        io.to(roomId).emit("spotlight-updated", userId);
      }
    });

    socket.on("disconnect", () => {
      rooms.forEach((room, roomId) => {
        if (room.participants.has(socket.id)) {
          const user = room.participants.get(socket.id);
          room.participants.delete(socket.id);
          
          if (room.participants.size === 0) {
            rooms.delete(roomId);
          } else if (user?.isHost) {
            // Assign new host
            const nextId = room.participants.keys().next().value;
            const nextUser = room.participants.get(nextId);
            if (nextUser) {
              nextUser.isHost = true;
              io.to(roomId).emit("user-updated", nextUser);
            }
          }
          
          io.to(roomId).emit("user-left", socket.id);
        }
      });
      console.log("User disconnected:", socket.id);
    });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`MeetLite Pro Server running on http://localhost:${PORT}`);
  });
}

startServer();
