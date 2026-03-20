/**
 * EventBus — internal pub/sub for service events
 * Bridges service state changes to WebSocket clients
 */

import { EventEmitter } from 'events';
import type { ServiceId, ServiceStatus, RunRecord, ErrorRecord } from './ServiceState';

export interface ServiceEvent {
    type: string;
    timestamp: string;
    serviceId?: ServiceId;
    data: Record<string, unknown>;
}

class EventBusImpl extends EventEmitter {
    private history: ServiceEvent[] = [];
    private maxHistory = 200;

    emit(event: string, ...args: any[]): boolean {
        // Store in history
        if (args[0] && typeof args[0] === 'object') {
            const evt: ServiceEvent = {
                type: event,
                timestamp: new Date().toISOString(),
                serviceId: args[0].serviceId,
                data: args[0],
            };
            this.history.push(evt);
            if (this.history.length > this.maxHistory) {
                this.history = this.history.slice(-this.maxHistory);
            }
        }
        return super.emit(event, ...args);
    }

    getRecentEvents(count: number = 50): ServiceEvent[] {
        return this.history.slice(-count);
    }

    getEventsForService(serviceId: ServiceId, count: number = 50): ServiceEvent[] {
        return this.history
            .filter(e => e.serviceId === serviceId)
            .slice(-count);
    }
}

export const eventBus = new EventBusImpl();

// Event type constants
export const EVENTS = {
    SERVICE_STATE_CHANGE: 'service:stateChange',
    SERVICE_RUN_START: 'service:runStart',
    SERVICE_RUN_COMPLETE: 'service:runComplete',
    SERVICE_ERROR: 'service:error',
    BROWSER_STATUS_CHANGE: 'browser:statusChange',
    SYSTEM_HEALTH: 'system:health',
} as const;
