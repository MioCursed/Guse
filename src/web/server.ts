import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import cors from 'cors';
import { env } from '../config/env';

export const app = express();
export const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
    cors: {
        origin: '*', // For testing purposes, you can restrict this to PUBLIC_URL
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/room/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('join-room', (roomId, userId) => {
        socket.join(roomId);
        socket.to(roomId).emit('user-connected', userId);
        
        console.log(`User ${userId} joined room ${roomId}`);

        socket.on('disconnect', () => {
            socket.to(roomId).emit('user-disconnected', userId);
            console.log(`User ${userId} disconnected from room ${roomId}`);
        });

        socket.on('offer', (data) => {
            socket.to(roomId).emit('offer', data);
        });

        socket.on('answer', (data) => {
            socket.to(roomId).emit('answer', data);
        });

        socket.on('ice-candidate', (data) => {
            socket.to(roomId).emit('ice-candidate', data);
        });
        
        socket.on('stop-sharing', (userId) => {
             socket.to(roomId).emit('user-stopped-sharing', userId);
        });
    });
});

export function startWebServer() {
    const port = parseInt(env.PORT, 10);
    httpServer.listen(port, () => {
        console.log(`🚀 Web server listening on port ${port}`);
        console.log(`🌍 Public URL: ${env.PUBLIC_URL}`);
    });
}
