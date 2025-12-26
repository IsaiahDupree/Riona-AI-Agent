-- SQL function to get comment method statistics
-- This provides optimized aggregation for method performance

CREATE OR REPLACE FUNCTION get_comment_method_stats()
RETURNS TABLE (
    method TEXT,
    total_uses BIGINT,
    successful BIGINT,
    failed BIGINT,
    success_rate NUMERIC,
    avg_time_ms NUMERIC,
    min_time_ms INTEGER,
    max_time_ms INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        (metadata->>'comment_method')::TEXT as method,
        COUNT(*) as total_uses,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) as failed,
        ROUND(
            100.0 * SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) / COUNT(*), 
            2
        ) as success_rate,
        ROUND(
            AVG((metadata->>'comment_method_attempt_time_ms')::INTEGER), 
            0
        ) as avg_time_ms,
        MIN((metadata->>'comment_method_attempt_time_ms')::INTEGER) as min_time_ms,
        MAX((metadata->>'comment_method_attempt_time_ms')::INTEGER) as max_time_ms
    FROM interactions
    WHERE type = 'comment'
        AND metadata->>'comment_method' IS NOT NULL
        AND metadata->>'comment_method_attempt_time_ms' IS NOT NULL
    GROUP BY metadata->>'comment_method'
    ORDER BY success_rate DESC, avg_time_ms ASC;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION get_comment_method_stats() TO anon, authenticated;

COMMENT ON FUNCTION get_comment_method_stats() IS 'Get aggregated statistics for each comment submission method';
