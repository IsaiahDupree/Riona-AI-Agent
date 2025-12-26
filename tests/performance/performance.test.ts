import { delay } from '../../src/utils/delay';

describe('Performance & Efficiency Tests', () => {
    describe('Utility Performance', () => {
        it('should execute delay within acceptable tolerance', async () => {
            const startTime = Date.now();
            await delay(1000);
            const elapsed = Date.now() - startTime;

            // Allow 10% tolerance
            expect(elapsed).toBeGreaterThanOrEqual(900);
            expect(elapsed).toBeLessThan(1200);
        });
    });

    describe('Memory Efficiency', () => {
        it('should not leak memory during repeated operations', async () => {
            const initialMemory = process.memoryUsage().heapUsed;

            // Simulate repeated operations
            for (let i = 0; i < 100; i++) {
                await delay(10);
            }

            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }

            const finalMemory = process.memoryUsage().heapUsed;
            const memoryIncrease = finalMemory - initialMemory;

            // Memory increase should be minimal (less than 10MB)
            expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024);
        });
    });

    describe('Startup Performance', () => {
        it('should load core modules quickly', () => {
            const startTime = Date.now();

            // Simulate module loading
            require('../../src/utils/logger');
            require('../../src/utils/delay');

            const elapsed = Date.now() - startTime;

            // Should load in under 1 second
            expect(elapsed).toBeLessThan(1000);
        });
    });
});
