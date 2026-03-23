import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ override: true });

interface MethodStats {
    method: string;
    total_uses: number;
    successful: number;
    failed: number;
    success_rate: number;
    avg_time_ms: number;
    min_time_ms: number;
    max_time_ms: number;
}

interface MethodAttempt {
    method: string;
    success: boolean;
    time_ms: number;
    error?: string;
}

export class CommentMethodAnalyzer {
    private supabase: SupabaseClient;

    constructor() {
        const url = process.env.SUPABASE_URL!;
        const key = process.env.SUPABASE_KEY!;
        this.supabase = createClient(url, key);
    }

    /**
     * Get success rates for each comment method
     */
    async getMethodSuccessRates(): Promise<MethodStats[]> {
        const { data, error } = await this.supabase.rpc('get_comment_method_stats');

        if (error) {
            console.error('Error fetching method stats:', error);

            // Fallback: manual query
            const { data: interactions, error: queryError } = await this.supabase
                .from('interactions')
                .select('metadata, status, created_at')
                .eq('type', 'comment')
                .not('metadata->comment_method', 'is', null);

            if (queryError) throw queryError;

            return this.aggregateMethodStats(interactions);
        }

        return data;
    }

    /**
     * Manually aggregate method statistics from interactions
     */
    private aggregateMethodStats(interactions: any[]): MethodStats[] {
        const methodsMap = new Map<string, {
            total: number,
            successful: number,
            failed: number,
            times: number[]
        }>();

        for (const interaction of interactions) {
            const method = interaction.metadata?.comment_method;
            const isSuccess = interaction.status === 'success';
            const time = interaction.metadata?.comment_method_attempt_time_ms || 0;

            if (!method) continue;

            if (!methodsMap.has(method)) {
                methodsMap.set(method, {
                    total: 0,
                    successful: 0,
                    failed: 0,
                    times: []
                });
            }

            const stats = methodsMap.get(method)!;
            stats.total++;
            if (isSuccess) {
                stats.successful++;
            } else {
                stats.failed++;
            }
            if (time > 0) {
                stats.times.push(time);
            }
        }

        const results: MethodStats[] = [];
        for (const [method, stats] of methodsMap.entries()) {
            const avgTime = stats.times.length > 0
                ? stats.times.reduce((sum, t) => sum + t, 0) / stats.times.length
                : 0;

            results.push({
                method,
                total_uses: stats.total,
                successful: stats.successful,
                failed: stats.failed,
                success_rate: (stats.successful / stats.total) * 100,
                avg_time_ms: Math.round(avgTime),
                min_time_ms: stats.times.length > 0 ? Math.min(...stats.times) : 0,
                max_time_ms: stats.times.length > 0 ? Math.max(...stats.times) : 0
            });
        }

        return results.sort((a, b) => b.success_rate - a.success_rate);
    }

    /**
     * Get detailed attempt history for all methods
     */
    async getMethodAttemptHistory(limit = 100): Promise<{
        interaction_id: string;
        created_at: string;
        successful_method: string;
        all_attempts: MethodAttempt[];
    }[]> {
        const { data, error } = await this.supabase
            .from('interactions')
            .select('id, created_at, metadata')
            .eq('type', 'comment')
            .not('metadata->comment_method_attempts', 'is', null)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;

        return data.map(row => ({
            interaction_id: row.id,
            created_at: row.created_at,
            successful_method: row.metadata?.comment_method || 'unknown',
            all_attempts: row.metadata?.comment_method_attempts || []
        }));
    }

    /**
     * Generate comprehensive comparison report
     */
    async generateComparisonReport(): Promise<string> {
        const stats = await this.getMethodSuccessRates();

        let report = '# Comment Method Comparison Report\n\n';
        report += `Generated: ${new Date().toISOString()}\n\n`;

        report += '## Overall Statistics\n\n';
        report += '| Method | Uses | Successes | Failures | Success Rate | Avg Time (ms) | Min Time | Max Time |\n';
        report += '|--------|------|-----------|----------|--------------|---------------|----------|----------|\n';

        for (const stat of stats) {
            report += `| ${stat.method} | ${stat.total_uses} | ${stat.successful} | ${stat.failed} | ${stat.success_rate.toFixed(2)}% | ${stat.avg_time_ms} | ${stat.min_time_ms} | ${stat.max_time_ms} |\n`;
        }

        report += '\n## Recommendations\n\n';

        if (stats.length === 0) {
            report += 'No data available yet. Run the bot with comment interactions to collect data.\n';
        } else {
            const best = stats[0];
            report += `**Most Reliable Method**: ${best.method}\n`;
            report += `- Success Rate: ${best.success_rate.toFixed(2)}%\n`;
            report += `- Average Time: ${best.avg_time_ms}ms\n`;
            report += `- Total Uses: ${best.total_uses}\n\n`;

            if (stats.length > 1) {
                report += '**Method Ranking** (by success rate):\n';
                stats.forEach((stat, index) => {
                    report += `${index + 1}. ${stat.method} (${stat.success_rate.toFixed(2)}%)\n`;
                });
            }
        }

        return report;
    }

    /**
     * Get method performance over time (to detect degradation)
     */
    async getMethodPerformanceOverTime(method: string, days = 7): Promise<{
        date: string;
        success_rate: number;
        total_uses: number;
    }[]> {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const { data, error } = await this.supabase
            .from('interactions')
            .select('created_at, status, metadata')
            .eq('type', 'comment')
            .eq('metadata->comment_method', method)
            .gte('created_at', startDate.toISOString());

        if (error) throw error;

        // Group by date
        const byDate = new Map<string, { total: number, successful: number }>();

        for (const row of data) {
            const date = row.created_at.split('T')[0];
            if (!byDate.has(date)) {
                byDate.set(date, { total: 0, successful: 0 });
            }
            const stats = byDate.get(date)!;
            stats.total++;
            if (row.status === 'success') {
                stats.successful++;
            }
        }

        return Array.from(byDate.entries()).map(([date, stats]) => ({
            date,
            success_rate: (stats.successful / stats.total) * 100,
            total_uses: stats.total
        })).sort((a, b) => a.date.localeCompare(b.date));
    }
}

// CLI usage
if (require.main === module) {
    const analyzer = new CommentMethodAnalyzer();

    analyzer.generateComparisonReport().then(report => {
        console.log(report);
    }).catch(error => {
        console.error('Error generating report:', error);
    });
}
