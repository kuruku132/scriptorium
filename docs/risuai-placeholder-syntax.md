# RisuAI 플레이스홀더 / CBS(Custom Block Syntax) 문법 정리

RisuAI의 프롬프트 문자열 안에서 처리되는 템플릿/플레이스홀더 문법은 **CBS(Custom Block Syntax)**라 불리며 `{{ ... }}` 형태를 쓴다.

인자 구분자는 `::`이다.

- 단일 태그: `{{name::arg1::arg2}}`
- 블록: `{{#name ...}}...{{/}}`
- 블록 종료는 `{{/name}}` 형태도 사용할 수 있다.
- 별칭(alias)은 각 항목의 `[...]` 안에 표기한다.

---

## 1. 블록 디렉티브

### 1.1 조건문

| 구문 | 동작 |
|---|---|
| `{{#when condition}}...{{/when}}` | 권장 조건문 |
| `{{#when::keep condition}}...{{/when}}` | 본문 공백 보존 |
| `{{:else}}` | `#when` 또는 `#each` 내부의 else 분기 |
| `{{#if condition}}...{{/if}}` | deprecated. `#when` 사용 권장 |
| `{{#if_pure condition}}...{{/if_pure}}` | deprecated. `#when::keep` 사용 권장 |

`#when`은 `::` 대신 공백으로 조건을 구분할 수도 있다.

```text
{{#when 1}}
내용
{{/when}}
```

`{{:else}}`는 단일 라인에서는 같은 줄에 둘 수 있고, 멀티라인에서는 별도 줄에 두는 편이 안전하다.

### 1.2 `#when` 연산자

`::`로 연산자를 연결하며 **오른쪽에서 왼쪽으로 결합**한다.

#### 논리 연산자

- `not`
- `and`
- `or`

#### 비교 연산자

- `is`
- `isnot`
- `>`
- `<`
- `>=`
- `<=`

수치 비교는 숫자로 변환해 처리한다.

#### 변수 / 토글

- `var::A` — 채팅 변수 `A`가 truthy인지 확인
- `toggle::name` — 글로벌 토글 `toggle_name`이 truthy인지 확인
- `A::vis::B` — 변수 `A == B`
- `A::visnot::B` — 변수 `A != B`
- `A::tis::B` — 토글 `A == B`
- `A::tisnot::B` — 토글 `A != B`

#### 공백 모드

- `keep` — 공백 보존
- `legacy` — 기존 `#if` 방식의 trim 처리

예시:

```text
{{#when::keep::not::condition}}
내용
{{/when}}

{{#when::keep::A::and::B}}
내용
{{/when}}
```

`#when`의 복합 조건은 일반적인 연산자 우선순위와 다르게 동작할 수 있으므로, 복잡한 `or` 조합은 가능하면 조건을 나누는 편이 안전하다.

### 1.3 레거시 단일 중괄호 조건문

```text
{#if condition
content#}
```

deprecated 문법이다.

조건이 빈 문자열, `0`, `-1`이면 빈 문자열을 반환하고, 그 외에는 본문을 출력한다.

---

### 1.4 순수 출력 / 이스케이프 / 정규화

| 구문 | 동작 |
|---|---|
| `{{#puredisplay}}...{{/}}` | 내부 CBS를 처리하지 않고 그대로 출력 |
| `{{#pure_display}}...{{/}}` | `puredisplay`와 동일 |
| `{{#pure}}...{{/}}` | deprecated |
| `{{#code}}...{{/}}` | 개행/탭 제거 및 이스케이프 시퀀스 변환 |
| `{{#escape}}...{{/}}` | 중괄호/괄호 이스케이프, 본문 trim |
| `{{#escape::keep}}...{{/}}` | 공백을 보존하며 이스케이프 |

`#code`에서는 `\uXXXX`, `\n`, `\r`, `\t`, `\b`, `\f`, `\v`, `\a`, `\x` 등의 이스케이프 시퀀스를 처리한다.

---

### 1.5 루프

```text
{{#each A as V}}
...
{{/}}
```

JSON 배열 `A`를 순회한다.

`as`는 생략 가능하다.

```text
{{#each [1,2,3] n}}
{{slot::n}}
{{/}}
```

요소 접근에는 `{{slot::V}}`를 사용한다.

공백을 보존하려면:

```text
{{#each::keep A as V}}
...
{{/}}
```

배열이 아닌 값은 반복하지 않고 그대로 통과할 수 있다. 중첩 루프도 가능하다.

별칭:

- `#each`
- `:each`

---

### 1.6 함수 블록

함수 정의:

```text
{{#func arg1 arg2 ...}}
함수 본문
{{/}}
```

호출:

```text
{{call::funcname::arg1::arg2::...}}
```

함수 본문에서 호출 인자 접근:

```text
{{arg::N}}
```

`N`번째 호출 인자로 치환된다.

호출 깊이가 너무 깊으면 콜스택 제한 오류가 발생할 수 있다.

---

## 2. 단일 플레이스홀더

### 2.1 캐릭터 / 프롬프트 메타

- `char` [`bot`]
- `user`
- `persona` [`userpersona`]
- `personality` [`charpersona`]
- `description` [`chardesc`]
- `scenario`
- `exampledialogue` [`examplemessage`, `example_dialogue`]
- `mainprompt` [`systemprompt`, `main_prompt`]
- `jb` [`jailbreak`]
- `globalnote` [`systemnote`, `ujb`]
- `authornote` [`author_note`]
- `lorebook` [`worldinfo`]
- `userhistory` [`usermessages`, `user_history`]
- `charhistory` [`charmessages`, `char_history`]
- `history` [`messages`]
- `previouscharchat` [`lastcharmessage`]
- `previoususerchat` [`lastusermessage`]
- `previouschatlog` [`previous_chat_log`]
- `chatindex` [`chat_index`]
- `firstmsgindex` [`firstmessageindex`, `first_msg_index`]
- `isfirstmsg` [`isfirstmessage`]
- `lastmessage`
- `lastmessageid` [`lastmessageindex`]
- `trigger_id` [`triggerid`]
- `blank` [`none`]

`previouschatlog`는 다음처럼 특정 이전 메시지를 가져올 수 있다.

```text
{{previouschatlog::N}}
```

범위를 벗어나면 `"Out of range"`가 반환될 수 있다.

---

### 2.2 시간

- `messagetime` [`message_time`]
- `messagedate` [`message_date`]
- `messageunixtimearray` [`message_unixtime_array`]
- `unixtime`
- `time`
- `isotime`
- `isodate`
- `date` [`datetimeformat`]
- `messageidleduration` [`message_idle_duration`]
- `idleduration` [`idle_duration`]

---

### 2.3 모델 / 시스템

- `model`
- `axmodel`
- `role`
- `jbtoggled`
- `maxcontext`
- `moduleenabled` [`module_enabled`]
- `moduleassetlist` [`module_assetlist`]

메타데이터:

```text
{{metadata::KEY}}
```

사용 가능한 주요 키:

- `mobile`
- `local`
- `node`
- `version`
- `majorversion` [`majorver`, `major`]
- `language` [`locale`, `lang`]
- `browserlanguage` [`browserlocale`, `browserlang`]
- `modelshortname`
- `modelname`
- `modelinternalid`
- `modelformat`
- `modelprovider`
- `modeltokenizer`
- `imateapot`
- `risutype`
- `maxcontext`

---

### 2.4 변수

- `getvar`
- `setvar`
- `addvar`
- `setdefaultvar`
- `getglobalvar`
- `calc`
- `tempvar` [`gettempvar`]
- `settempvar`
- `return`

선언:

```text
{{declare::name}}
```

---

### 2.5 논리 / 비교 / 암호

- `equal`
- `notequal` [`not_equal`]
- `greater`
- `less`
- `greaterequal` [`greater_equal`]
- `lessequal` [`less_equal`]
- `and`
- `or`
- `not`
- `xor` [`xorencrypt`, `xorencode`, `xore`]
- `xordecrypt` [`xordecode`, `xord`]
- `crypt` [`crypto`, `caesar`, `encrypt`, `decrypt`]
- `iserror`

---

### 2.6 문자열

- `startswith`
- `endswith`
- `contains`
- `replace`
- `split`
- `join`
- `spread`
- `trim`
- `length`
- `lower`
- `upper`
- `capitalize`
- `reverse`

---

### 2.7 수학

- `calc`
- `round`
- `floor`
- `ceil`
- `abs`
- `remaind`
- `tonumber`
- `pow`
- `range`
- `min`
- `max`
- `sum`
- `average`
- `fixnum` [`fixnumber`]
- `randint`
- `dice`
- `roll`
- `rollp` [`rollpick`]
- `random`
- `pick`
- `fromhex`
- `tohex`

`roll` / `rollp`는 `XdY` 형식의 주사위 표기법을 사용할 수 있다.

---

### 2.8 배열 / 객체

- `arraylength`
- `arrayelement`
- `dictelement` [`objectelement`]
- `objectassert` [`dictassert`, `object_assert`]
- `element` [`ele`]
- `arrayshift`
- `arraypop`
- `arraypush`
- `arraysplice`
- `arrayassert`
- `makearray` [`array`, `a`]
- `makedict` [`dict`, `d`, `makeobject`, `object`, `o`]
- `filter`
- `all`
- `any`

---

### 2.9 유니코드 / 해시

- `unicodeencode` [`unicode_encode`]
- `unicodedecode` [`unicode_decode`]
- `u` [`unicodedecodefromhex`]
- `ue` [`unicodeencodefromhex`]
- `hash`

---

### 2.10 이스케이프 / 특수 기호

- `br` [`newline`] → 실제 줄바꿈
- `cbr` [`cnl`, `cnewline`] → 리터럴 `\n`
- `decbo` [`displayescapedcurlybracketopen`] → `{`
- `decbc` [`displayescapedcurlybracketclose`] → `}`
- `bo` [`ddecbo`, `doubledisplayescapedcurlybracketopen`] → `{{`
- `bc` [`ddecbc`, `doubledisplayescapedcurlybracketclose`] → `}}`
- `displayescapedbracketopen` [`debo`, `(`] → `(`
- `displayescapedbracketclose` [`debc`, `)`] → `)`
- `displayescapedanglebracketopen` [`deabo`, `<`] → 화면상 `<`
- `displayescapedanglebracketclose` [`deabc`, `>`] → 화면상 `>`
- `displayescapedcolon` [`dec`, `:`] → `:`
- `displayescapedsemicolon` [`;`] → `;`

---

### 2.11 수식 / 주석

수식:

```text
{{? expression}}
```

지원되는 주요 연산:

- 산술: `+ - * / % ^`
- 비교: `== != < > <= >=`
- 괄호 그룹

예시:

```text
{{? 1+2}}
```

주석:

```text
{{// comment}}
```

출력에서 제거된다.

```text
{{comment::text}}
```

채팅에는 표시되지만 모델 요청에서는 제거된다.

내부 전용 문법:

```text
{{__ ...}}
```

---

### 2.12 화면 표시

#### 미디어

- `asset`
- `emotion`
- `audio`
- `bg`
- `bgm`
- `video`
- `video-img`
- `image`
- `img`
- `path` [`raw`]

#### 인레이

- `inlay`
- `inlayed`
- `inlayeddata`
- `source::user`
- `source::char`

#### 포맷

- `tex` [`latex`, `katex`]
- `ruby` [`furigana`]
- `codeblock`

#### 목록

- `emotionlist`
- `assetlist`
- `chardisplayasset`

---

### 2.13 출력 조작

- `bkspc` — 마지막 단어 제거
- `erase` — 마지막 문장 제거
- `hiddenkey` — lore 활성화 키로만 사용하고 출력에는 포함하지 않음

---

### 2.14 기타

- `button`
- `risu`
- `file`
- `prefillsupported` [`prefill_supported`, `prefill`]
- `screenwidth` [`screen_width`]
- `screenheight` [`screen_height`]
- `slot`
- `position::name`

---

## 3. `@@` 데코레이터

`{{...}}` 형태의 CBS와 별개로, 줄 단위 `@@` 접두사를 사용하는 문법이 있다.

- `@@probability N` — 발동 확률
- `@@depth N` — 삽입 깊이
- `@@role system|user|assistant` — 메시지 역할
- `@@exclude_keys`
- `@@exclude_keys_all`
- `@@additional_keys`
- `@@activate_only_after N`
- `@@match_full_word`
- `@@match_partial_word`
- `@@indicator phi|character_desc|character_first_message|persona`
- `@@move_top`
- `@@move_bottom`
- `@@emo ...`
- `@@inject`
- `@@repeat_back`
- `@@system`
- `@@mcp`
- `@@position <name>`
- `@@@end`
- `@@end`

`@@position <name>`은 `{{position::name}}`과 연동된다.

`@@@end` / `@@end`는 블록 종료 용도로 사용된다.

---

## 4. 레거시 특수 토큰

다음 HTML식 태그도 대응하는 플레이스홀더처럼 사용할 수 있다.

| 토큰 | 대응 |
|---|---|
| `<user>` | `{{user}}` |
| `<char>` | `{{char}}` |
| `<bot>` | `{{bot}}` |

---

## 5. 문법상 주의사항

- `#if`, `#if_pure`, `#pure`는 deprecated이다.
  - `#if` → `#when`
  - `#if_pure` → `#when::keep`
  - `#pure` → `#puredisplay`
- `#when`의 복합 `or` 조건은 예상한 우선순위와 다르게 평가될 수 있으므로 복잡한 식은 분리하는 편이 안전하다.
- `cbr::N` 반복은 정상 동작하지 않을 수 있다.
- CBS 인자에는 다음 문자를 직접 넣기 어렵다:
  - `#`
  - `:`
  - `{`
  - `}`
  - 줄바꿈
- 같은 이름을 가리키는 여러 alias가 존재할 수 있다.
