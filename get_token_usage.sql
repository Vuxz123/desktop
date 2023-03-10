SELECT
    model,
    coalesce(sum(total_tokens), 0) as sum,
    coalesce(count(*), 0) as count
FROM textCompletionUsage
WHERE date(timestamp, 'start of month') = date(?, 'start of month')
GROUP BY model
ORDER BY count DESC