<!-- AUTO-GENERATED from hippocampus.ts — не редактировать вручную -->
| Ключ | Значение по умолчанию | Примечание |
|---|---|---|
| `enabled` | ```true``` |  |
| `capRatio` | ```0.20``` |  |
| `hysteresis` | ```0.7``` |  |
| `maxUnitTokens` | ```4000``` |  |
| `freshTurns` | ```2``` |  |
| `markerBudgetTokens` | ```1000``` |  |
| `addToGitignore` | ```true``` |  |
| `redactSecrets` | ```true``` |  |
| `protectedBlocks` | ```["PERSONA"]``` |  |
| `maxCoreMemoryChars` | ```12000``` |  |
| `maxCoreBlocks` | ```12``` |  |
| `maxMemfsFileBytes` | ```65536``` |  |
| `maxMemfsFiles` | ```200``` |  |
| `maxMemfsTotalBytes` | ```2097152``` |  |
| `maxWikiPages` | ```500``` |  |
| `maxWikiTotalBytes` | ```8388608``` | // 8 MiB across active wiki pages (archive/ excluded) |
| `memfsTtlDays` | ```30``` |  |
| `retentionDays` | ```90``` |  |
| `maxRecallBytes` | ```20971520``` |  |
| `maxArchiveBytes` | ```104857600``` |  |
| `maxCheckpoints` | ```20``` |  |
| `captureMaxBytes` | ```33554432``` |  |
| `captureMaxItemBytes` | ```4194304``` |  |
| `captureMaxCount` | ```500``` |  |
| `captureMaxSessions` | ```8``` |  |
| `maxToolOutputLogChars` | ```4096``` |  |
| `maxArgsLogChars` | ```1024``` |  |
| `contextLookupMaxBytes` | ```65536``` |  |
| `pruneIntervalMinutes` | ```30``` |  |
| `logLevel` | ```"error"``` | // raise to "debug" or "trace" in .hippocampus/hippocampus.json for more detail |
| `maxLogBytes` | ```10485760``` |  |
| `previewLines` | ```3``` |  |
| `maxAttachmentBytes` | ```8388608``` |  |
| `maxAuditLogBytes` | ```5242880``` |  |
| `maxAttachmentsBytes` | ```536870912``` |  |
| `redactMaxBytes` | ```1048576``` |  |
| `systemBlockTtlMs` | ```5000``` |  |
| `unknownContextWindow` | ```32768``` | // conservative on purpose: overflow (request > model limit) is unrecoverable mid-turn, sticky over-eviction is not |
