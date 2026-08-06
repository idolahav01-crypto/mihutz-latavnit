# אלגוריתם בניית האתרים — גישת "עריכה ושידרוג" (TransformDesigner + Patch)

הענף `transform-approach`. הגישה כאן: **לנתח את הקוד הקיים ולערוך/לשדרג אותו** — או
בעריכת-על של קובץ שלם (TransformDesigner), או בהטלאות ממוקדות לפי סימן (Patch/Apply).

> זו הגישה שקדמה ל-`main`. הגישה הנוכחית ב-`main` (בנייה מחדש מאפס) החליפה אותה כי
> הכיסוי כאן משתנה מאוד לפי סוג האתר (SPA, CSS חיצוני, דפים גדולים). ראה SITE_BUILD_ALGORITHM.md
> ב-`main` לפרטים.

---

## מבט-על

```
ingest → detect (108 סימנים + ציון) → [ TransformDesigner  |  Design→Apply→QA ] → features → declutter → deliver
```

כל שלב מול המודל מפוצל ל**קריאות נפרדות מונעות-לקוח** בגלל קיר ה-~150 שניות לכל קריאת edge.

---

## שלב 0 — Ingest
אריזת קוד המקור ל-`bundle.txt` (`=== FILE: path ===`) ב-Storage תחת `{uid}/{sid}/bundle.txt`.

## שלב 1 — Detect
`detect` מריץ מול **108 סימני AI** (`signals.json`), recall אגרסיבי + re-hunt, ציטוט מילולי חובה.
### ציון דטרמיניסטי
```
score = round(100 × Σ(משקל present&applicable) ÷ Σ(משקל כל הישימים))   [high=3, medium=2, low=1]
```
0 = אנושי · 100 = AI. נשמר ב-`ai_fingerprint_score`.

---

## מסלול A — TransformDesigner (עריכת-על של קובץ שלם) — המסלול הראשי
`transform`. לכל קובץ HTML, **שתי קריאות** (כל אחת 150 שניות משלה):
1. **phase "structure"** — משכתב את markup ה-`<body>` למבנה חדש נועז, תוך שימור **כל**
   class/id/data-attr/handler/route + כל התוכן והעובדות + placeholders של `<script>`.
2. **phase "css"** — מייצר גיליון סגנון חדש שלם + קישורי פונטים למבנה החדש.
- קובץ `.css`/`.scss` = קריאת `cssfile` אחת (שכתוב CSS מלא).
- ה-`<script>` נשלפים ונשמרים byte-for-byte (המודל לא רואה/כותב JS).
- `design_direction` ננעל בקובץ הראשון ומשוחזר בשאר לקוהרנטיות.
- הפלט נכתב ל-`edited-bundle.txt`.

## מסלול B — Design → Apply → QA (הטלאות לפי סימן) — הישן יותר
1. **`design`** — לכל סימן present מפיק זוג `old_code` (מילולי, ייחודי) → `new_code` (drop-in מלא).
   מפוצל ל-passes (part 1 קובע design_direction). מאמת שכל `old_code` הוא substring ייחודי.
2. **`apply`** — **דטרמיניסטי, בלי קריאת מודל**: מחיל כל fix בהחלפת מחרוזת מדויקת
   (עם fallback לא-רגיש-לרווחים), בסדר תלויות. לא יכול ל-timeout ולא עולה כסף. → `edited-bundle.txt`.
3. **`qa`** — בקרת איכות: משווה מול המקור לפאריטי פונקציונלי + דורש שינוי נראה לעין.

## שלב 3 — Features
`features`. **part 1** מציע 5 פיצ'רים (`features.json`); **parts 2..6** מממשים אחד לכל
קריאה ומזריקים ל-HTML הראשי (CSS ל-`<style>`, HTML לפני `<footer>`, JS כ-`<script>`).

## שלב 4 — Declutter (הצעה בלבד)
`declutter`. סוקר את האתר ו**מציע** מה מיותר להסרה — **לעולם לא מוחק בלי אישור משתמש**.
"לא להסיר כלום" הוא מענה תקין.

## שלב 5 — Deliver
`package` בונה zip בדפדפן; אפשר Pull Request ל-GitHub (ענף נפרד).

---

## חוזי-ברזל של המסלול הזה
- **שימור מוחלט**: class/id/data-attr/handler/route + כל העובדות + ה-`<script>`.
- **עוגן מילולי**: fix לפי הטלאה חייב `old_code` שהוא substring מילולי ייחודי, אחרת נדחה.
- **קיר 150 שניות** → פיצול לקריאות; apply דטרמיניסטי כדי לא ל-timeout.

## מגבלות ידועות (הסיבה למעבר ל-rebuild)
- SPA (React/Next): כמעט אין markup סטטי לשכתוב; ה-CSS מכוון לסלקטורים שנוצרים רק בריצה.
- CSS חיצוני/Tailwind: רק בלוק ה-`<style>` הראשון מוחלף; utilities מנצחים.
- דפים גדולים: חיתוך פלט (maxTokens). markup לא-סטנדרטי: `splitBody` נכשל.

## קבצי Storage
```
{uid}/{sid}/bundle.txt         קלט
{uid}/{sid}/edited-bundle.txt  פלט (הקבצים שנגעו בהם)
{uid}/{sid}/features.json      5 פיצ'רים
```

## פונקציות edge
`detect` · `design` · `apply` · `qa` · `transform` · `features` · `declutter` · `package` ·
`push-github` · `fetch-repo` · `list-repos`
