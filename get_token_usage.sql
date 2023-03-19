SELECT
    model,
    coalesce(sum(prompt_tokens), 0) as prompt_tokens_sum,
    coalesce(sum(completion_tokens), 0) as completion_tokens_sum,
    coalesce(count(*), 0) as count
FROM textCompletionUsage
WHERE date(timestamp, 'start of month') = date(?, 'start of month')
GROUP BY model
ORDER BY count DESC