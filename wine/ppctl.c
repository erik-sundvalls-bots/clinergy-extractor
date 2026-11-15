/*
 * ppctl: drive the Clinergy / PEN&PAD demo (penpad.exe) under Wine, where the
 * frame window's menu bar does not show (GetMenu returns NULL). It posts the
 * menu commands directly and fills in the "Load model" dialog.
 *
 *   ppctl cmd load|symptom|disease|topics|about|<number>   post WM_COMMAND to the Pen&Pad window
 *   ppctl text <string>                                     set the first Edit box of the open dialog
 *   ppctl ok                                                press OK in the open dialog / message box
 *   ppctl find                                              exit 0 once the Pen&Pad window exists
 *
 * Build: i686-w64-mingw32-gcc -O1 -o ppctl.exe ppctl.c
 * Command ids used: 32771 Load model, 32772 Symptom selector, 32773 Disease
 * selector, 32774 Topics, 57664 About (57664 is MFC's standard ID_APP_ABOUT).
 */
#include <windows.h>
#include <stdio.h>
#include <string.h>

static HWND gDlg = NULL, gEdit = NULL, gMain = NULL;

/* the main frame: a visible top-level window whose title starts with "Pen&Pad" */
static BOOL CALLBACK find_main(HWND h, LPARAM lp) {
    char title[256] = "";
    GetWindowTextA(h, title, sizeof title);
    if (!gMain && IsWindowVisible(h) && !strncmp(title, "Pen&Pad", 7)) gMain = h;
    return TRUE;
}

static BOOL CALLBACK find_edit(HWND h, LPARAM lp) {
    char cls[64] = "";
    GetClassNameA(h, cls, sizeof cls);
    if (!gEdit && !lstrcmpiA(cls, "Edit")) gEdit = h;
    return TRUE;
}

/* the dialog or message box: an untitled, "penpad", "...Model..." or "...Load..." top-level window */
static BOOL CALLBACK find_dialog(HWND h, LPARAM lp) {
    char title[256] = "";
    if (!IsWindowVisible(h)) return TRUE;
    GetWindowTextA(h, title, sizeof title);
    if (!title[0] || !lstrcmpiA(title, "penpad") || strstr(title, "Model") || strstr(title, "Load")) {
        gDlg = h;
        EnumChildWindows(h, find_edit, 0);
    }
    return TRUE;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "find")) {
        EnumWindows(find_main, 0);
        return gMain ? 0 : 1;
    }
    if (argc >= 3 && !strcmp(argv[1], "cmd")) {
        static const struct { const char *name; int id; } ids[] = {
            {"load", 32771}, {"symptom", 32772}, {"disease", 32773}, {"topics", 32774}, {"about", 57664}};
        int id = atoi(argv[2]);
        for (int i = 0; i < (int)(sizeof ids / sizeof ids[0]); i++)
            if (!stricmp(argv[2], ids[i].name)) id = ids[i].id;
        EnumWindows(find_main, 0);
        HWND h = gMain;
        if (!h || !id) { fprintf(stderr, "no Pen&Pad window or unknown command\n"); return 2; }
        return PostMessageA(h, WM_COMMAND, (WPARAM)id, 0) ? 0 : 3;
    }
    EnumWindows(find_dialog, 0);
    if (argc >= 2 && !strcmp(argv[1], "ok")) {
        if (!gDlg) return 2;
        PostMessageA(gDlg, WM_COMMAND, IDOK, 0);
        return 0;
    }
    if (argc >= 3 && !strcmp(argv[1], "text")) {
        if (!gEdit) { fprintf(stderr, "no edit box found\n"); return 2; }
        return SetWindowTextA(gEdit, argv[2]) ? 0 : 3;
    }
    fprintf(stderr, "usage: ppctl cmd <load|symptom|disease|topics|about|id> | text <s> | ok | find\n");
    return 2;
}
