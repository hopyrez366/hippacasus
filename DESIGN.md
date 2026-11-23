# Скользящее окно контекста — дизайн

> **Статус (обновлено 2026-10-24):** реализация эволюционировала в `hippocampus/hippocampus.ts` этого репозитория (один файл: lossless-окно + иерархическая память T0–T3, FTS5-wiki; ставится как `~/.config/opencode/plugin/hippocampus.ts`). Код и тесты — здесь; этот документ остаётся спецификацией исходного скользящего окна. E2E-проверено на qwen3.8-27b: окно ~13k токенов при сырой истории >100k, вербатим-reload через grep/sed по `.ai-context/`, встроенная компакция не срабатывала. Поправка 09-24b: в активном юните тул-выводы всегда полные (`!active` перед стаббингом в `renderAssistantMessage`/`unitTokens`) — модель видит результаты своих последних тулзов целиком; стабы действуют только для завершённых юнитов.

Lossless-скользящее окно для opencode: контекст никогда не суммаризируется, всё общение непрерывно пишется сырьём в `.ai-context/`, ушедшие за край окна сегменты заменяются указателями на уже лежащие файлы.

## 1. Суть

Контекст = **кэш с TTL по эфемерности**; диск (`.ai-context/`) = **source of truth**. Нигде нет суммаризации: ушедший из окна контент не сжимается и не переписывается — он уже лежит на диске верbatim, а в окне остаётся только указатель. История opencode **никогда не мутируется**: окно пересчитывается idempotently заново на каждый LLM-запрос (включая промежуточные запросы внутри tool-цикла) из полной сохранённой истории.

Явно НЕ делаем: компакцию/суммаризацию контента, SQLite/FTS5, кастомные recall-тулзы, авто-prefetch-инжекцию, LLM-вызовы на горячем пути (эвикция = строковые операции + запись файлов, миллисекунды).

## 2. Модель контента

**Юнит** = user-сообщение + все последующие сообщения до следующего user (тексты assistant, tool-вызовы и результаты). Юнит — атомарная единица: не разрезается никогда; tool call+result выкидываются только атомарно по callID.

Каждый вид parts имеет свой срок жизни в живом контексте:

| Контент | TTL в окне | После истечения |
|---|---|---|
| user + assistant **text** (решения, нарратив, логика) | долго — до тех пор, пока бюджет не вытеснит весь юнит | юнит целиком → одна строка-маркер на файл |
| tool **calls/args** («акционный лог»: что делала модель; для write/edit аргументы = сам код) | живёт со своим юнитом (маленькие, 10–200 токенов) | вместе с юнитом → маркер |
| tool **results** (выводы — самый эфемерный и токен-тяжёлый контент) | все юниты: >`inlineResultMaxTokens`(3000) → стаб, меньше → инлайн; `truncated: true` без capture → всегда стаб | `[tool bash output (full) → .ai-context/ses_abc.md#t_call_x, 1.2k tok]` (~15 токенов) |
| **reasoning** (model-internal) | как results: активный юнит в окне, старое — вне payload | молча; на диске всегда верbatim |

Обоснование TTL: доказательства (выводы, прочитанные файлы) устаревают быстрее всего и жрут больше всех токенов; логика же живёт в текстовых parts и не теряется при сбросе тулзов. Код не теряется никогда — он на диске + verbatim в `.ai-context`.

## 3. Хранилище: `.ai-context/`

**Один append-only файл на сессию.** Мелкая помойка из файлов не нужна: inode-давление, медленный glob (которым мы сами пользовались как TOC) — всё это убивается одним файлом, а UUID-заголовки юнитов внутри него являются индексом.

```
<worktree>/.ai-context/
  <sessionID>.md       # сырой лог сессии; sessionID = messages[0].info.sessionID (ses_…),
                       #   есть в каждом message/part, стабилен через встроенную компакцию
```

Формат файла — self-indexing: строка-заголовок юнита несёт весь индекс (uuid, время, роль, токены, hint):

```markdown
# session ses_abc123 · /home/admin2/Develop/myproj · started 2026-09-22T07:35

## u_msg_def456 · 07:35:12 · user→assistant · ~480 tok · billing stack choice: FastAPI, rejected Rust
[user] ...verbatim...
[assistant] ...text verbatim...
[tool read args={"filePath": "src/foo.py"}]

### t_call_9 · bash · full output (~2.1k tok)
<полный вывод verbatim>

## u_msg_ghi789 · 07:41:33 · user→assistant · ~1.9k tok · DB schema draft for users/orders/billing
...
```

- `u_<msgid>` — UUID юнита = id его ПЕРВОГО сообщения (детерминированно, нативный id opencode, без RNG). **`grep -n "^## u_" <file>` = оглавление всей сессии** одной командой.
- `### t_<callID>` — якорь на крупный tool-вывод внутри юнита: стаб в контексте указывает точно на него.

**Политика записи**:
- **Append-only, инкрементально по сообщениям**: каждый transform пишет и **активный** юнит — но только ещё не записанные сообщения (якорь `<!-- m_<msgid> -->` на каждое). Это критично: стаб в активном ходе ссылается на данные, которые должны быть на диске *до* следующего запроса модели, а не после idle.
- Полный tool-вывод = max(сохранённый part, capture из `tool.execute.after`, **spill-файл opencode**): при крупном выводе bash opencode обрезает part до превью и кладёт полный вывод в `~/.local/share/opencode/tool-output/tool_<id>` (путь — в `part.state.metadata.outputPath`; **лимит самого spill'а = 256 KB**). Хук читает spill-файл в capture; bounded in-memory кэш callID→output.
- **Idempotency**: in-memory set записанных message-id + один rescan файла при первом контакте (парсинг `<!-- m_ -->` и, для старых файлов без якорей, `^## u_`); недостающее дописывается одной append'ой (self-healing). Дублирование невозможно.
- Best-effort flush по событию `session.idle` — хвостовые сообщения после последнего transform; известный крошечный gap при hard-crash — приемлем.
- В момент эвикции **никаких записей не происходит** — данные уже на диске. При первом создании плагин дописывает `.ai-context/` в `.gitignore` проекта (флаг `addToGitignore`).

## 4. Алгоритм на каждый LLM-запрос

Хук: `experimental.chat.messages.transform` (срабатывает перед каждым запросом к модели, включая шаги tool-цикла):

1. **Unitization** — сообщения группируются в юниты (user → следующий user; кросс-чек по `parentID`). Подтверждено: каждый LLM-запрос добавляет ровно одно assistant-сообщение с parts `step-start / reasoning? / tool* / text? / step-finish`; user-сообщения — только `text`. Parts `step-*` из рендера в контекст не попадают (внутренние маркеры), на диск пишутся верbatim.
2. **Подсчёт токенов** по каждому юниту: chars/3 по всему рендеру юнита (тексты + args + outputs). `info.tokens` для размера юнита НЕ используется — в нём `input` = весь контекст запроса, а не вклад сообщения (проверено дампом). O(n) по истории, дёшево.
3. **Стаббинг tool-выводов — по порогу, без привилегий для активного юнита**: любой вывод > `inlineResultMaxTokens` (или `truncated: true` без полного capture) заменяется стабом с якорем `#t_<callID>` — в том числе в активном ходе. Именно это делает бюджет жёстким инвариантом: свежий 50k-вывод не раздувает запрос (до этого активного юнита «щадить» и уходить за триггер авто-компакции opencode). Малые выводы (≤3000 tok) остаются инлайн — поток не рвётся. Reasoning parts в окне только в активном юните; calls/args и text всегда остаются.
4. **TTL-каскад**: reasoning у завершённых юнитов уходит из payload.
5. **Бюджет**: сумма токенов окна сравнивается с `budgetRatio × limit.context` (0.4 × 131072 ≈ 52k); жёсткий потолок — `hardMax` = 0.75.
6. **Эвикция** при превышении: завершённые юниты от старых к новым, минуя последние `minKeepTurns`=3 и активный юнит. Эвикция всегда берёт **старший префикс** завершённых юнитов → все маркеры объединяются в один блок, который вставляется дополнительной строкой в начало user-текста **первого выжившего юнита**. Синтетических сообщений нет (роль не подменяем) → adjacency-проблем с ролями у провайдера исключены:

   ```
   [offloaded → .ai-context/ses_abc123.md#u_msg_def456 — "выбор стека: Python+FastAPI"]
   <исходный user-текст первого выжившего юнита>
   ```

   Путь относительный от корня проекта (cwd модели) → immune к переносу. Hint = heapuristic-заголовок (первое предложение, ~8 слов) — тот же, что в заголовке юнита внутри файла.
7. **Переполнение маркеров**: если строки-маркеры суммарно > `markerBudgetTokens` (~1k) — старейшие consecutive юниты схлопываются в один range-маркер `[u_0001–u_0040 offloaded → .ai-context/ses_abc123.md — TOC: grep -n "^## u_"]`; юниты в файле остаются целыми, оглавление даётся одной командой.
8. **Сборка payload**: system (+ одна статичная ~50-токенная заметка про механику `.ai-context`, через `system.transform`) + окно с юнитами, стабами и маркерами на местах выгруженного.

## 5. Что видит модель (пример payload)

```
[system] … + «выгруженные сегменты лежат в .ai-context/<session>.md, маркеры дают якорь #u_…/#t_… — тяни sed/grep»
[marker] [segment offloaded → .ai-context/ses_x.md#u_msg_a1 — "billing stack: FastAPI"]    ← выгруженный юнит
[user u6] «а теперь накидай схему БД»
[assistant text] «Окей, SQLite для локального хранения, потому что…»                      ← текст в окне
  [tool read call, args verbatim]                                                        ← calls/args живут с юнитом
  [tool read output (full) → .ai-context/ses_x.md#t_call_9, 2.1k tok]                    ← стаб (юнит завершён)
[user u7] «запусти тесты»                                                                  ← старт активного юнита
[assistant] … + tool bash call                                                             ← активный: reasoning и args на месте
[tool bash output (full) → .ai-context/ses_x.md#t_call_12, 4.2k tok]                       ← активный, но > порога → стаб (данные уже на диске)
```

Три состояния контента на одном экране: выгружено (маркер), в окне (текст/стаб/инлайн-вывод ≤ порога). Активный юнит отличается только живым reasoning.

## 6. Как данные возвращаются в контекст

Без кастомных механизмов — встроенными тулзами модели по `.ai-context` (путь внутри проекта → permissions не нужны):

1. **Позиционные маркеры и стабы** — стоят прямо в потоке диалога на месте удалённого контента: модель видит *где* что было и имеет точный якорь `#u_…`/`#t_…`.
2. **UUID-заголовки = индекс** — `grep -n "^## u_" .ai-context/<session>.md`: seq, время, роль, токены и hint по каждому юниту одной командой (self-indexing файл).
3. **Точечная выгрузка** — один bash-вызов на блок: `sed -n '/^## u_<uuid>/,/^## /p' <file>` для юнита, аналогично с `### t_<callID>` для вывода тула; итеративный grep по одному файлу для тематического поиска.
4. **Статичная заметка в system** учит механике (~60 токенов: где файлы, как читать якоря, sed-рецепт; стабильный текст = кэш-дружелюбно).

Худший случай = один `sed`/`grep` до verbatim-оригинала. Ничего не теряется никогда: сырой рекорд переживает и крах opencode, и срабатывание встроенной компакции.

## 7. Гарантии и инварианты

- **Lossless**: всё, что когда-либо прошло через контекст (тексты, calls+args, полные выводы, reasoning), существует verbatim в `.ai-context`.
- **Provider-safe**: нет orphan tool_calls/results — эвикция только целыми юнитами (старший префикс); последние два юнита (активный + предыдущий) никогда не эвиктируются, их выводы могут быть стабами — part'ы при этом сохраняются.
- **Idempotency и statelessness**: одна история → один payload; append-only лог, повторные запросы не дублируют записи (in-memory set uuid + rescan при первом контакте с файлом); внутренняя история opencode не мутируется.
- **Ограниченный контекст**: ≤ бюджета в штатном режиме, потолок 0.75; встроенная компакция (`auto: true, reserved: 16k`) остаётся аварийным тормозом далеко выше нашего порога — на практике не срабатывает, а если сработает — безвредна (рекорд цел).

## 8. Конфигурация (`.opencode/context-window.json`, дефолты)

| Параметр | Дефолт | Смысл |
|---|---|---|
| `budgetRatio` | 0.4 | цель по токенам окна от limit.context (~52k для 131k) |
| `hardMax` | 0.75 | жёсткий потолок, выше — принудительная эвикция дальше |
| `minKeepTurns` | 3 | последние завершённые юниты не выгружаются никогда |
| `toolFreshTurns` | 1 | **deprecated** (не используется: привилегия активного юнита заменена порогом) |
| `inlineResultMaxTokens` | 3000 | выводы меньше — инлайн (во всех юнитах), крупнее — стаб; `truncated` без capture — всегда стаб |
| `markerBudgetTokens` | 1000 | при переполнении старейшие маркеры схлопываются в range-маркер на файл сессии (TOC = `grep -n "^## u_"`) |
| `addToGitignore` | true | append `.ai-context/` в .gitignore при первом создании |

## 9. Краевые случаи

- **Subagents** (task tool): отдельная сессия → свой файл в `.ai-context`; payload родителя не затрагивается.
- **Перенос проекта**: session key = `sessionID` из истории, не путь → immune к перемещению.
- **Встроенная компакция всё же сработала**: `sessionID` (ses_…) в рамках одной сессии сохраняется → тот же файл, лог продолжается; юниты до summary остаются читаемыми по якорям. Новый файл только при поистине новой сессии.
- **Рост одного файла**: долгая сессия = один файл на несколько МБ — grep/sed/read по line-offset на таком работают мгновенно; чистка истории = `rm` одного файла. Файлов в `.ai-context/` всегда ≈ число сессий (десятки), не тысячи.
- **Prompt-caching**: окно/маркеры меняются при эвикциях → кэш инвалидируется; inherent цена подхода.
- **Слабое место для E2E**: нарратив локальной 35b — если модель плохо объясняет tool-шаги, стабы чаще потребуют read'ов; лечится поднятием `inlineResultMaxTokens` одним параметром.

## 10. Реализация

**Файлы:**

```
src/plugin-entry.ts                   # исходник плагина: хуки messages.transform + system.transform + tool.execute.after + session.idle
src/window.ts                         # unitization, TTL-каскад, бюджетный цикл, маркеры
src/offload.ts                        # append-only session log: uuid-заголовки/self-indexing, merge полных tool-выводов, gitignore
src/tokens.ts                         # token estimation (реальные info.tokens + chars/3)
test/*.test.ts                        # unit-тесты (node --experimental-strip-types --test) — 20/20
scripts/build-global.mjs              # бандлит src в один файл и ставит в ~/.config/opencode/plugin/
.opencode/context-window.json         # опциональный per-project конфиг (переопределение DEFAULT_CONFIG, contextLimit)
```

**Установка:** `node scripts/build-global.mjs` → `~/.config/opencode/plugin/context-window.ts` — плагин активен глобально во всех проектах. Одновременно держать копию в `.opencode/plugins/` НЕЛЬЗЯ — хуки сработают дважды.

**Этапы:**

1. **Пробник** *(готово — см. §11)*: дамп реальных форм Message/Part (как лежат tool call/result, callID-пэры), presence reasoning parts и `info.tokens`, частота срабатывания transform в tool-цикле → фиксируем правила под реальность.
2. `src/offload.ts` + тесты: append-only лог — idempotent append + rescan recovery (batch catch-up), uuid-заголовки как индекс, merge полных tool-выводов из captures, gitignore append.
3. `src/window.ts` + тесты на синтетических payload'ах: TTL-каскад (активный юнит / стабы / инлайн-порог), целостность callID, minKeepTurns, схлопывание маркеров в range при переполнении, идемпотентность повторных transform'ов.
4. Wiring плагина + конфиг *(готово)*.
5. **E2E-критерии** *(пройдено — см. §11 wire-семантика: mock-provider подтвердил окно на wire; recall E2E с реальным провайдером пройден — модель достала code word из `.ai-context` через grep TOC + sed)*: payload ≤ ~55k при длинном диалоге; ранние решения и выводы модель достаёт из `.ai-context` дословно по стабам/маркерам; цепочка дебага внутри активного юнита не рвётся; встроенная компакция не сработала (лог opencode); нет 400 от провайдера; повторные запросы не дублируют записи.

**Окружение:** Node 22.23.2, opencode 1.18.16, модель qwen 131k context / 15k output, `compaction: {auto: true, prune: true, reserved: 16000}`, `concurrency: 1`.

## 11. Подтверждённые формы (Stage-0 пробник)

Прогон `opencode run --auto` с двумя bash-вызовами; дампы в `/tmp/opencode/probe/`:

**Message.info (user):** `{role:"user", time:{created}, agent, model:{providerID,modelID}, id, sessionID}` (+ позже появляется `summary:{diffs:[]}`).
**Message.info (assistant):** `{parentID, role:"assistant", mode, agent, path:{cwd,root}, cost, tokens:{total,input,output,reasoning,cache:{write,read}}, modelID, providerID, time:{created,completed}, finish:"tool-calls"|…, id, sessionID}`.
⚠️ `tokens.input` = весь контекст запроса (9044 на первом же шаге) → для размера юнита непригоден; берём chars/3 по рендеру.

**Parts assistant-сообщения (порядок):** `step-start{}` → `reasoning{text,time:{start,end}}`? → `tool{tool,callID,state:{status:"completed"|"error", input, output, metadata:{output,exit,truncated}, title, time}}*` → `text{text}`? → `step-finish{reason,tokens,cost}`. **Tool-результат — part того же assistant-сообщения**, не отдельное сообщение; каждый LLM-запрос = +1 assistant-сообщение (msgs 1→2→3 в tool-цикле).

**Семантика хуков:**
- `experimental.chat.messages.transform` — ровно на каждый **главный** LLM-запрос (включая шаги tool-цикла), input `{}`, полная история в output. Вспомогательные запросы (генерация title) его не вызывают.
- `experimental.chat.system.transform` — на **каждый** LLM-вызов, включая вспомогательные (первый дамп = "You are a title generator") → инъекция заметки туда безвредна; input `{sessionID, model}`, output `{system: string[]}`.
- `tool.execute.after` — input `{tool, sessionID, callID, args}`, output `{title, output, metadata:{output,exit,truncated,outputPath?}}`. Для крупных выводов bash opencode кладёт в part превью + «Full output saved to: …» и полный текст (до **256 KB**) в spill-файл (`metadata.outputPath`) → capture обязан читать spill-файл; merge обязателен.
- Событие **`session.idle`** существует (видимо в events.log) → flush хвостового юнита по нему.

**Plugin loader:** glob `{plugin,plugins}/*.{ts,js}` относительно `.opencode/` проекта и глобального конфига; TS грузится как есть (bun-runtime); экспорт — функция `(input: PluginInput, options?) => Promise<Hooks>` (named export или default).

**Wire-семантика `messages.transform` (подтверждено mock-provider'ом на 127.0.0.1):**
- `output.messages` мутируется **in-place**: opencode держит локальную ссылку на тот же массив (`prompt.ts`: trigger с `{messages: msgs}`, затем тот же `msgs` уходит в провайдера). Замена свойства (`output.messages = newArray`) молча игнорируется — на wire улетает сырая история. Корректно: `arr.length = 0; for (const m of window) arr.push(m)`.
- Порядок в хуке обязателен: **сначала offload RAW-сообщений** (`writeUnits`), потом in-place окно. Иначе (a) юниты с prepended-маркерами уходят на диск дословно (загрязнение source of truth), (b) evicted-юниты становятся невидимы для `writeUnits`. Страховка от потери: `flushIdle` по `session.idle` перечитывает свежую RAW-историю через `client.session.messages` и дописывает всё, включая активный юнит.
- E2E подтверждено дважды: (1) mock-provider — в запросах после eviction маркеры `[offloaded → …]` присутствуют, вытесненный контент на wire отсутствует; (2) реальный провайдер (qwen, budget 240 tok) — модель не помнила code word из контекста, сама выполнила `grep -n "^## u_"` (TOC) и `sed -n '/^## u_<id>/,/^## /p'` по `.ai-context/<ses>.md`, вернула дословное значение + путь файла.

**Верификация варианта B (стаббинг активного юнита, порог 3000 tok) — headless `opencode run -m qwen/qwen3.8-27b`:** bash-вывод ~400k символов (больше контекстного лимита модели). До B такой ход давал запросы ~73–90k и авто-компакцию opencode. Результат: (1) **авто-компакция не сработала**, запросы 1020/84/61 новых токенов (+cache ≈ 9–10k) при бюджете 52k; (2) крупный вывод в активном ходе стабится, полный текст на диске *до* следующего запроса (per-message запись активного юнита); (3) модель достала secret из `.ai-context` одним `grep -o` и ответила верно — 3 запроса против 8 до фикса. Платформенный лимит: spill-файл opencode ограничен 256 KB → для выводов >256KB хвост теряется самим opencode, плагин сохраняет всё, что он держит.
