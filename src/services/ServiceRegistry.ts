/**
 * ServiceRegistry — central registry for all service orchestrators
 */

import { ServiceOrchestrator } from './ServiceOrchestrator';
import { browserPool } from '../browser/BrowserPool';
import { eventBus, EVENTS } from './EventBus';
import type { ServiceId, ServiceState } from './ServiceState';
import { SERVICE_DISPLAY_NAMES } from './ServiceState';

class ServiceRegistryImpl {
    private services = new Map<ServiceId, ServiceOrchestrator>();

    register(orchestrator: ServiceOrchestrator): void {
        this.services.set(orchestrator.id, orchestrator);
    }

    get(id: ServiceId): ServiceOrchestrator | undefined {
        return this.services.get(id);
    }

    getAll(): ServiceOrchestrator[] {
        return Array.from(this.services.values());
    }

    getAllStates(): ServiceState[] {
        return this.getAll().map(s => s.getState());
    }

    getHealthSummary(): {
        healthy: number;
        degraded: number;
        failed: number;
        stopped: number;
        services: Array<{ id: ServiceId; displayName: string; status: string; lastRunAt: string | null }>;
        browsers: ReturnType<typeof browserPool.getStatus>;
        uptime: number;
    } {
        const states = this.getAllStates();
        let healthy = 0, degraded = 0, failed = 0, stopped = 0;

        for (const s of states) {
            switch (s.status) {
                case 'idle':
                case 'running':
                case 'cooling_down':
                    healthy++;
                    break;
                case 'error':
                case 'recovering':
                    degraded++;
                    break;
                case 'failed':
                    failed++;
                    break;
                case 'stopped':
                    stopped++;
                    break;
            }
        }

        return {
            healthy,
            degraded,
            failed,
            stopped,
            services: states.map(s => ({
                id: s.id,
                displayName: SERVICE_DISPLAY_NAMES[s.id],
                status: s.status,
                lastRunAt: s.lastRunAt,
            })),
            browsers: browserPool.getStatus(),
            uptime: process.uptime(),
        };
    }

    /**
     * Start all registered services
     */
    startAll(): void {
        for (const svc of this.services.values()) {
            svc.start();
        }
    }

    /**
     * Stop all registered services and close all browsers
     */
    async stopAll(): Promise<void> {
        for (const svc of this.services.values()) {
            svc.stop();
        }
        await browserPool.shutdownAll();
    }

    /**
     * Get aggregated error history across all services
     */
    getAllErrors(limit: number = 100): Array<{ serviceId: ServiceId } & import('./ServiceState').ErrorRecord> {
        const allErrors: any[] = [];
        for (const svc of this.services.values()) {
            for (const err of svc.getErrors()) {
                allErrors.push({ serviceId: svc.id, ...err });
            }
        }
        // Sort by timestamp descending
        allErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return allErrors.slice(0, limit);
    }
}

export const serviceRegistry = new ServiceRegistryImpl();
