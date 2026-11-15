/*
 * probe.c - dump the knowledge base of the 1998 Clinergy / PEN&PAD terminology
 * engine (TermEng.dll) to plain-text files.
 *
 * This file is original code written for the PEN&PAD revival project. It
 * contains NO Clinergy code or data: it only calls functions that the user's
 * own copy of TermEng.dll exports, under Wine (or on Windows).
 *
 * Build (32-bit Windows target; Debian/Ubuntu package "gcc-mingw-w64-i686"):
 *     i686-w64-mingw32-gcc -O1 -o probe.exe probe.c
 *
 * Run from the directory that holds TermEng.dll and its MFC42/MSVCRT deps:
 *     wine probe.exe <model-base-path> <output-dir>
 * e.g. wine probe.exe C:\Clinergy\Compdata\archive\model C:\out
 *
 * Outputs in <output-dir>:
 *     vis.txt.vf/.vc/.vl/.vs  FileOutVis: feature/criterial-link/laterality/sublocation visibilities
 *     lang.txt                FileOutLangRules: descriptor precedences + summary-sentence rules
 *     values.txt              FileOutValues: value precedences
 *     search.txt              FileOutSearchSpace: the type-ahead search index
 *     permids.txt             FileOutPermanentIDs: permanent ids of entities
 *     entities.tsv            one line per entity id with the results of per-entity queries
 *     exams.tsv               the examination tree plus some global lists
 *
 * How the calls work: TermEng.dll is an MSVC 5 C++ DLL exporting methods of
 * class CTerminologyEngine (MSVC-mangled names). Methods use the __thiscall
 * convention (object pointer in ECX), which mingw supports via
 * __attribute__((thiscall)). Arguments are MFC types (CString, CStringArray);
 * instead of linking MFC we build binary-compatible fakes:
 *   - a CString is a char* that points just past a CStringData header
 *     {nRefs, nDataLength, nAllocLength}. We pin nRefs very high so the DLL's
 *     MFC never tries to free or copy-on-write our buffers.
 *   - a CStringArray is {vtable, CString* data, size, maxSize, growBy}. The DLL
 *     fills it using its own MFC (SetSize/Add), so we only read it back.
 * The engine object itself is just a large zeroed heap block handed to the
 * exported constructor (the real sizeof is smaller than 1 MB).
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define TC __attribute__((thiscall))

/* ---- fake MFC types ----------------------------------------------------- */
typedef struct { LONG nRefs; int nDataLength; int nAllocLength; } CStringData;
typedef struct { void *vptr; char **pData; int nSize; int nMax; int nGrow; } CStringArray;

/* Make a CString-compatible char* holding a copy of s. */
static char *cstr(const char *s) {
  int n = (int)strlen(s);
  char *b = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(CStringData) + n + 1);
  CStringData *h = (CStringData *)b;
  h->nRefs = 100000; /* pinned: never freed by MFC */
  h->nDataLength = n;
  h->nAllocLength = n;
  memcpy(b + sizeof(CStringData), s, n + 1);
  return b + sizeof(CStringData);
}
static const char *safe(const char *p) { return p ? p : ""; }
static void *dummy_vtable[16];
static CStringArray new_array(void) { CStringArray a = {dummy_vtable, 0, 0, 0, 0}; return a; }

/* ---- method signatures (all __thiscall) --------------------------------- */
typedef void (TC *ctor_fn)(void *);
typedef int (TC *str_strref_fn)(void *, char *, char **);   /* f(CString, CString&) */
typedef void (TC *str_fn)(void *, char *);                  /* f(CString) */
typedef short (TC *str_short_fn)(void *, char *);
typedef void (TC *counts_fn)(void *, WORD *, WORD *);
typedef int (TC *id_strref_fn)(void *, WORD, char **);      /* f(WORD id, CString&) */
typedef short (TC *id_strref_short_fn)(void *, WORD, char **);
typedef int (TC *id_arr_fn)(void *, WORD, CStringArray *);  /* f(WORD id, CStringArray&) */
typedef int (TC *id_int_fn)(void *, WORD);
typedef int (TC *supers_fn)(void *, WORD, CStringArray *, CStringArray *);
typedef void (TC *arr3_fn)(void *, CStringArray *, CStringArray *, CStringArray *);
typedef int (TC *str_arr_int_fn)(void *, char *, CStringArray *, int);
typedef int (TC *str_arr_fn)(void *, char *, CStringArray *);
typedef int (TC *str_intref_fn)(void *, char *, int *);
typedef int (TC *str_strref_word_fn)(void *, char *, char **, WORD *);
typedef int (TC *str_strref2_fn)(void *, char *, char **, char **);
typedef void (TC *arr_fn)(void *, CStringArray *);
typedef void (TC *strref_fn)(void *, char **);

static HMODULE dll;
static void *eng; /* the CTerminologyEngine instance */

/* Look up an exported (mangled) method; exit if missing. */
static void *method(const char *mangled) {
  void *p = (void *)GetProcAddress(dll, mangled);
  if (!p) { fprintf(stderr, "probe: missing export %s\n", mangled); exit(3); }
  return p;
}

/* Write "\t<tag>[n]=a|b|c" for a per-entity array query (nothing if empty). */
static void write_array(FILE *f, const char *tag, const char *mangled, WORD id) {
  CStringArray a = new_array();
  ((id_arr_fn)method(mangled))(eng, id, &a);
  if (a.nSize <= 0) return;
  fprintf(f, "\t%s[%d]", tag, a.nSize);
  for (int i = 0; i < a.nSize; i++) fprintf(f, "%s%s", i ? "|" : "=", safe(a.pData[i]));
}
static void write_list(FILE *f, const char *tag, CStringArray *a) {
  if (a->nSize <= 0) return;
  fprintf(f, "\t%s[%d]", tag, a->nSize);
  for (int i = 0; i < a->nSize; i++) fprintf(f, "%s%s", i ? "|" : "=", safe(a->pData[i]));
}

/* ---- 1. the engine's own text exporters --------------------------------- */
static void dump_fileouts(const char *outdir) {
  static const char *fo[] = {
    "?FileOutVis@CTerminologyEngine@@QAEHVCString@@AAV2@@Z", "vis.txt",
    "?FileOutLangRules@CTerminologyEngine@@QAEHVCString@@AAV2@@Z", "lang.txt",
    "?FileOutValues@CTerminologyEngine@@QAEHVCString@@AAV2@@Z", "values.txt",
    "?FileOutSearchSpace@CTerminologyEngine@@QAEHVCString@@AAV2@@Z", "search.txt", 0};
  char path[MAX_PATH];
  for (int i = 0; fo[i]; i += 2) {
    char *err = cstr("");
    snprintf(path, sizeof path, "%s\\%s", outdir, fo[i + 1]);
    int r = ((str_strref_fn)method(fo[i]))(eng, cstr(path), &err);
    printf("%s -> %d %s\n", fo[i + 1], r, safe(err));
  }
  snprintf(path, sizeof path, "%s\\permids.txt", outdir);
  ((str_fn)method("?FileOutPermanentIDs@CTerminologyEngine@@QAEXVCString@@@Z"))(eng, cstr(path));
  printf("permids.txt done\n");
}

/* ---- 2. per-entity queries -> entities.tsv ------------------------------ */
static void dump_entities(const char *outdir, int max_id) {
  /* Array-valued queries, written as "\t<tag>[n]=a|b". Tag names are ours. */
  static const char *arrays[] = {
    "critLinks", "?GetCriterialLinks@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "assocSigns", "?assocSigns@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "exams", "?examinations@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "tsLinks", "?topicSelectorLinks@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "treatments", "?treatments@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "systemLinks", "?systemLinks@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "locativeLinks", "?locativeLinks@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "formLinkTopics", "?formLinkTopics@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "visFeatureAtts", "?VisFeatureAtts@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z",
    "sensibles", "?sensibleSanctions@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z", 0};
  char path[MAX_PATH];
  snprintf(path, sizeof path, "%s\\entities.tsv", outdir);
  FILE *f = fopen(path, "w");
  if (!f) { fprintf(stderr, "probe: cannot write %s\n", path); exit(4); }
  id_strref_fn name = (id_strref_fn)method("?getEntityNameFromID@CTerminologyEngine@@QAEHGAAVCString@@@Z");
  id_strref_fn category = (id_strref_fn)method("?getClinicalCategory@CTerminologyEngine@@QAEHGAAVCString@@@Z");
  id_strref_fn summary = (id_strref_fn)method("?getSummaryType@CTerminologyEngine@@QAEHGAAVCString@@@Z");
  id_strref_short_fn topic = (id_strref_short_fn)method("?getTopicString@CTerminologyEngine@@QAEFGAAVCString@@@Z");
  id_int_fn relevance = (id_int_fn)method("?findEntityRelevance@CTerminologyEngine@@QAE?AW4RelevanceType@@G@Z");
  id_int_fn show_subloc = (id_int_fn)method("?showSubLocations@CTerminologyEngine@@QAEHG@Z");
  id_int_fn left_handed = (id_int_fn)method("?isLeftHanded@CTerminologyEngine@@QAEHG@Z");
  supers_fn supers = (supers_fn)method("?entitySupers@CTerminologyEngine@@QAEHGAAVCStringArray@@AAVCWordArray@@@Z");
  int n = 0;
  for (int id = 0; id < max_id; id++) {
    char *s = cstr("");
    if (!name(eng, (WORD)id, &s) || !s || !*s) continue; /* unused id */
    char *c = cstr(""), *st = cstr(""), *tp = cstr("");
    category(eng, (WORD)id, &c);
    summary(eng, (WORD)id, &st);
    topic(eng, (WORD)id, &tp);
    fprintf(f, "%d\t%s\tcat=%s\tsum=%s\trel=%d\ttopic=%s", id, s, safe(c), safe(st),
            relevance(eng, (WORD)id), safe(tp));
    for (int k = 0; arrays[k]; k += 2) write_array(f, arrays[k], arrays[k + 1], (WORD)id);
    fprintf(f, "\tshowSubLoc=%d\tleftHanded=%d", show_subloc(eng, (WORD)id), left_handed(eng, (WORD)id));
    /* second array is really a CWordArray; same memory layout, we ignore it */
    CStringArray S = new_array(), W = new_array();
    supers(eng, (WORD)id, &S, &W);
    write_list(f, "supers", &S);
    write_array(f, "visSubLocAtts", "?VisSubLocAtts@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z", (WORD)id);
    write_array(f, "visToolLaterality", "?VisToolLaterality@CTerminologyEngine@@QAEHGAAVCStringArray@@@Z", (WORD)id);
    fprintf(f, "\n");
    n++;
  }
  fclose(f);
  printf("entities.tsv done (%d entities)\n", n);
}

/* ---- 3. examination tree + global lists -> exams.tsv -------------------- */
static void dump_exams(const char *outdir) {
  char path[MAX_PATH];
  snprintf(path, sizeof path, "%s\\exams.tsv", outdir);
  FILE *f = fopen(path, "w");
  if (!f) { fprintf(stderr, "probe: cannot write %s\n", path); exit(4); }
  /* A = root exam(s), B = system exams, C = location exams */
  CStringArray A = new_array(), B = new_array(), C = new_array();
  ((arr3_fn)method("?GetExamNames@CTerminologyEngine@@QAEXAAVCStringArray@@00@Z"))(eng, &A, &B, &C);
  fprintf(f, "#examnames %d %d %d\n", A.nSize, B.nSize, C.nSize);
  str_arr_int_fn signs = (str_arr_int_fn)method("?SignsForExam@CTerminologyEngine@@QAEHVCString@@AAVCStringArray@@H@Z");
  str_arr_fn subexams = (str_arr_fn)method("?SubExamsForExam@CTerminologyEngine@@QAEHVCString@@AAVCStringArray@@@Z");
  str_arr_fn symptom_links = (str_arr_fn)method("?SymptomLinksForExam@CTerminologyEngine@@QAEHVCString@@AAVCStringArray@@@Z");
  str_intref_fn is_lateral = (str_intref_fn)method("?IsExamLateral@CTerminologyEngine@@QAEHVCString@@AAH@Z");
  str_strref_word_fn super_level = (str_strref_word_fn)method("?SuperAndLevelForExam@CTerminologyEngine@@QAEHVCString@@AAV2@AAG@Z");
  str_strref2_fn base_location = (str_strref2_fn)method("?BaseLocationForExam@CTerminologyEngine@@QAEHVCString@@AAV2@1@Z");

  /* Work queue: start with A, B, C; sub-exams found on the way are appended
   * (group 3) so the whole tree is visited once. */
  enum { MAXQ = 4000 };
  static char *queue[MAXQ];
  static int group[MAXQ];
  int nq = 0;
  CStringArray *top[3] = {&A, &B, &C};
  for (int g = 0; g < 3; g++)
    for (int i = 0; i < top[g]->nSize && nq < MAXQ; i++) { group[nq] = g; queue[nq++] = strdup(safe(top[g]->pData[i])); }
  for (int qi = 0; qi < nq; qi++) {
    char *e = cstr(queue[qi]);
    int lateral = 0; WORD level = 0;
    char *sup = cstr(""), *b1 = cstr(""), *b2 = cstr("");
    is_lateral(eng, e, &lateral);
    super_level(eng, e, &sup, &level);
    base_location(eng, e, &b1, &b2);
    fprintf(f, "g%d\t%s\tlateral=%d\tsuper=%s\tlevel=%u\tbase=%s|%s", group[qi], queue[qi], lateral,
            safe(sup), level, safe(b1), safe(b2));
    for (int m = 0; m < 2; m++) { /* m=0/1: two sign modes of the engine */
      CStringArray S = new_array(); char tag[8];
      signs(eng, e, &S, m); snprintf(tag, sizeof tag, "signs%d", m); write_list(f, tag, &S);
    }
    CStringArray S = new_array();
    subexams(eng, e, &S);
    write_list(f, "subexams", &S);
    for (int k = 0; k < S.nSize; k++) {
      int dup = 0;
      for (int q = 0; q < nq; q++) if (!strcmp(queue[q], safe(S.pData[k]))) { dup = 1; break; }
      if (!dup && nq < MAXQ) { group[nq] = 3; queue[nq++] = strdup(safe(S.pData[k])); }
    }
    CStringArray L = new_array();
    symptom_links(eng, e, &L);
    write_list(f, "symptomLinks", &L);
    fprintf(f, "\n");
  }
  /* Global lists, "#list <name>[n]=a|b" */
  static const char *lists[] = {
    "tsSystems", "?GetTSSystems@CTerminologyEngine@@QAEXAAVCStringArray@@@Z",
    "tsLocations", "?GetTSLocations@CTerminologyEngine@@QAEXAAVCStringArray@@@Z",
    "summaryTypes", "?getSummaryTypes@CTerminologyEngine@@QAEXAAVCStringArray@@@Z",
    "modalityValues", "?GetModalityValues@CTerminologyEngine@@QAEXAAVCStringArray@@@Z",
    "featureDescriptors", "?GetFeatureDescriptors@CTerminologyEngine@@QAEXAAVCStringArray@@@Z",
    "sublocAtts", "?GetSublocAtts@CTerminologyEngine@@QAEXAAVCStringArray@@@Z", 0};
  for (int k = 0; lists[k]; k += 2) {
    CStringArray S = new_array();
    ((arr_fn)method(lists[k + 1]))(eng, &S);
    fprintf(f, "#list %s[%d]", lists[k], S.nSize);
    for (int j = 0; j < S.nSize; j++) fprintf(f, "%s%s", j ? "|" : "=", safe(S.pData[j]));
    fprintf(f, "\n");
  }
  char *ver = cstr("");
  ((strref_fn)method("?GetModelVersionData@CTerminologyEngine@@QAEXAAVCString@@@Z"))(eng, &ver);
  fprintf(f, "#version %s\n", safe(ver));
  fclose(f);
  printf("exams.tsv done (%d exams)\n", nq);
}

int main(int argc, char **argv) {
  if (argc < 3) { fprintf(stderr, "usage: probe.exe <model-base-path> <output-dir>\n"); return 2; }
  dll = LoadLibraryA("TermEng.dll");
  if (!dll) { fprintf(stderr, "probe: cannot load TermEng.dll (error %lu)\n", GetLastError()); return 1; }
  eng = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 1 << 20);
  ((ctor_fn)method("??0CTerminologyEngine@@QAE@XZ"))(eng);
  char *err = cstr("");
  int ok = ((str_strref_fn)method("?LoadModel28@CTerminologyEngine@@QAEHVCString@@AAV2@@Z"))(eng, cstr(argv[1]), &err);
  printf("LoadModel28(%s) = %d %s\n", argv[1], ok, safe(err));
  if (!ok) return 5;
  WORD n_entities = 0, n_attributes = 0;
  ((counts_fn)method("?GetConceptCounts@CTerminologyEngine@@QAEXAAG0@Z"))(eng, &n_entities, &n_attributes);
  printf("counts entities=%u attributes=%u\n", n_entities, n_attributes);
  fflush(stdout);
  dump_fileouts(argv[2]); fflush(stdout);
  dump_entities(argv[2], n_entities + 8); fflush(stdout); /* ids are 0..n_entities-1 */
  dump_exams(argv[2]);
  return 0;
}
