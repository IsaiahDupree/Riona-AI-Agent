/**
 * WebSocket Handler — real-time event streaming to clients
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { eventBus, EVENTS } from '../services/EventBus';
import { serviceRegistry } from '../services/ServiceRegistry';
import { logger } from '../utils/logger';

let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server): WebSocketServer {
    wss = new WebSocketServer({ server, path: '/ws' });

    wss.on('connection', (ws: WebSocket) => {
        logger.info('[ws] Client connected');

        // Send current state on connect
        ws.send(JSON.stringify({
            type: 'system:snapshot',
            timestamp: new Date().toISOString(),
            data: {
                services: serviceRegistry.getAllStates(),
                health: serviceRegistry.getHealthSummary(),
            },
        }));

        ws.on('close', () => {
            logger.debug('[ws] Client disconnected');
        });

        ws.on('error', (err) => {
            logger.debug(`[ws] Client error: ${err.message}`);
        });
    });

    // Bridge EventBus events to all WebSocket clients
    const eventNames = Object.values(EVENTS);
    for (const eventName of eventNames) {
        eventBus.on(eventName, (data: any) => {
            broadcast({
                type: eventName,
                timestamp: new Date().toISOString(),
                data,
            });
        });
    }

    // Periodic health heartbeat every 30s
    setInterval(() => {
        if (wss && wss.clients.size > 0) {
            broadcast({
                type: EVENTS.SYSTEM_HEALTH,
                timestamp: new Date().toISOString(),
                data: serviceRegistry.getHealthSummary(),
            });
        }
    }, 30_000);

    logger.info(`[ws] WebSocket server attached at /ws`);
    return wss;
}

function broadcast(message: object): void {
    if (!wss) return;
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

export function getWSS(): WebSocketServer | null {
    return wss;
}
