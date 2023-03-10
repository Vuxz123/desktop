WITH RECURSIVE parents AS (
    SELECT id, parent
    FROM message
    WHERE id = ?
    UNION
    SELECT message.id, message.parent
    FROM parents
    JOIN message ON message.id = parents.parent
)
SELECT id FROM parents