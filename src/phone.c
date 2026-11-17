#include "phone.h"

#include <ctype.h>
#include <json.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include "server.h"
extern char** environ;
char *phone_socket = "ttyp", *phone_session = "phone";
static uv_mutex_t commands;
typedef struct peer {
  struct pss_tty* pss;
  struct peer* next;
  bool busy, phone;
  uint64_t seen, used;
  int cols, rows;
  char* reply;
} peer;
static peer* peers;
static unsigned pending_jobs;
typedef struct {
  uv_work_t work;
  peer* client;
  json_object* request;
  char* reply;
  int cols, rows;
} job;

/* Each invocation has an argv boundary and runs off the websocket event loop. */
static int run(char** args, char** output, const char* input) {
  int out[2];
  FILE* source = tmpfile();
  if (!source) {
    *output = strdup("Cannot allocate command input");
    return -1;
  }
  if (input && fwrite(input, 1, strlen(input), source) != strlen(input)) {
    fclose(source);
    *output = strdup("Cannot write command input");
    return -1;
  }
  rewind(source);
  if (pipe(out)) {
    fclose(source);
    *output = strdup("Cannot allocate command output");
    return -1;
  }
  char* argv[40] = {"tmux", "-L", phone_socket, "-f", "/dev/null"};
  int n = 5;
  for (int i = 0; args[i] && n < 39; i++) argv[n++] = args[i];
  argv[n] = NULL;
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, fileno(source), 0);
  posix_spawn_file_actions_adddup2(&actions, out[1], 1);
  posix_spawn_file_actions_adddup2(&actions, out[1], 2);
  posix_spawn_file_actions_addclose(&actions, out[0]);
  posix_spawn_file_actions_addclose(&actions, out[1]);
  posix_spawn_file_actions_addclose(&actions, fileno(source));
  pid_t pid;
  int error = posix_spawnp(&pid, "tmux", &actions, NULL, argv, environ);
  posix_spawn_file_actions_destroy(&actions);
  fclose(source);
  close(out[1]);
  if (error) {
    close(out[0]);
    *output = strdup("Cannot execute tmux");
    return -1;
  }
  size_t used = 0, capacity = 1048576;
  char* buf = malloc(capacity + 1);
  struct pollfd fd = {out[0], POLLIN, 0};
  while (used < capacity) {
    if (poll(&fd, 1, 10000) <= 0) {
      kill(pid, SIGKILL);
      break;
    }
    ssize_t count = read(out[0], buf + used, capacity - used);
    if (count <= 0) break;
    used += count;
  }
  if (used == capacity) kill(pid, SIGKILL);
  close(out[0]);
  int status;
  waitpid(pid, &status, 0);
  buf[used] = 0;
  *output = buf;
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}
#define RUN(...) run((char*[]){__VA_ARGS__, NULL}, &out, NULL)
static bool name_ok(const char* s) {
  if (!s || !*s || strlen(s) > 64) return false;
  for (; *s; s++)
    if (!isalnum((unsigned char)*s) && *s != '-' && *s != '_') return false;
  return true;
}
int phone_setup(void) {
  if (!name_ok(phone_socket) || !name_ok(phone_session) || server->url_arg) {
    fprintf(stderr, "ttyp: invalid socket/session name or unsupported --url-arg\n");
    return -1;
  }
  char* out = NULL;
  int exists = RUN("has-session", "-t", phone_session);
  free(out);
  out = NULL;
  if (exists && RUN("new-session", "-d", "-s", phone_session, "-c", server->cwd ? server->cwd : ".") != 0) {
    fprintf(stderr, "ttyp: %s\n", out);
    free(out);
    return -1;
  }
  free(out);
  RUN("set-option", "-t", phone_session, "status", "off");
  free(out);
  RUN("set-option", "-t", phone_session, "history-limit", "5000");
  free(out);
  RUN("set-option", "-w", "-t", phone_session, "window-size", "manual");
  free(out);
  for (int i = 0; i < server->argc; i++) free(server->argv[i]);
  free(server->argv);
  char* args[] = {"tmux", "-L", phone_socket, "attach-session", "-t", phone_session, NULL};
  server->argc = 6;
  server->argv = calloc(7, sizeof(char*));
  for (int i = 0; i < 6; i++) server->argv[i] = strdup(args[i]);
  uv_mutex_init(&commands);
  return 0;
}
static const char* str(json_object* o, const char* key) {
  json_object* v = NULL;
  return json_object_object_get_ex(o, key, &v) && json_object_is_type(v, json_type_string) ? json_object_get_string(v)
                                                                                           : "";
}
static int number(json_object* o, const char* key) {
  json_object* v = NULL;
  return json_object_object_get_ex(o, key, &v) ? json_object_get_int(v) : 0;
}
static json_object* windows(void) {
  char* out = NULL;
  json_object* list = json_object_new_array();
  if (RUN("list-windows", "-t", phone_session, "-F", "#{window_id}") == 0) {
    char* save = NULL;
    for (char* id = strtok_r(out, "\n", &save); id; id = strtok_r(NULL, "\n", &save))
      json_object_array_add(list, json_object_new_string(id));
  }
  free(out);
  return list;
}
static bool belongs(json_object* ids, const char* id) {
  for (size_t i = 0; i < json_object_array_length(ids); i++)
    if (!strcmp(id, json_object_get_string(json_object_array_get_idx(ids, i)))) return true;
  return false;
}
static void execute(uv_work_t* work) {
  job* j = work->data;
  uv_mutex_lock(&commands);
  json_object *reply = json_object_new_object(), *ids = windows();
  const char *op = str(j->request, "op"), *id = str(j->request, "id");
  char* out = NULL;
  int result = 0;
  if (!strcmp(op, "create")) {
    if (json_object_array_length(ids))
      result = RUN("new-window", "-t", phone_session, "-c", server->cwd ? server->cwd : ".");
    else
      result = RUN("new-session", "-d", "-s", phone_session, "-c", server->cwd ? server->cwd : ".");
  } else if (strcmp(op, "state")) {
    if (!belongs(ids, id)) {
      result = -1;
      out = strdup("This terminal no longer exists");
    } else if (!strcmp(op, "select"))
      result = RUN("select-window", "-t", (char*)id);
    else if (!strcmp(op, "close"))
      result = RUN("kill-window", "-t", (char*)id);
    else if (!strcmp(op, "rename")) {
      const char* name = str(j->request, "name");
      if (!*name || strlen(name) > 128 || strpbrk(name, "\r\n\t")) {
        result = -1;
        out = strdup("Use a name of 1–128 bytes without tabs or newlines");
      } else
        result = RUN("rename-window", "-t", (char*)id, (char*)name);
    } else if (!strcmp(op, "capture")) {
      result = RUN("capture-pane", "-p", "-J", "-t", (char*)id, "-S", "-5000");
      if (!result) json_object_object_add(reply, "text", json_object_new_string(out));
    } else if (!strcmp(op, "insert")) {
      result = run((char*[]){"load-buffer", "-b", "ttyp-compose", "-", NULL}, &out, str(j->request, "text"));
      if (!result) {
        free(out);
        out = NULL;
        result = RUN("paste-buffer", "-d", "-p", "-b", "ttyp-compose", "-t", (char*)id);
      }
    } else {
      result = -1;
      out = strdup("Unknown operation");
    }
  }
  if (result) json_object_object_add(reply, "error", json_object_new_string(out ? out : "tmux operation failed"));
  free(out);
  json_object_put(ids);
  ids = windows();
  json_object* tabs = json_object_new_array();
  for (size_t i = 0; i < json_object_array_length(ids); i++) {
    const char* wid = json_object_get_string(json_object_array_get_idx(ids, i));
    json_object* tab = json_object_new_object();
    json_object_object_add(tab, "id", json_object_new_string(wid));
    RUN("display-message", "-p", "-t", (char*)wid, "#{window_name}");
    out[strcspn(out, "\r\n")] = 0;
    json_object_object_add(tab, "name", json_object_new_string(out));
    free(out);
    RUN("display-message", "-p", "-t", (char*)wid, "#{window_active}");
    json_object_object_add(tab, "active", json_object_new_boolean(atoi(out)));
    free(out);
    char cols[16], rows[16];
    snprintf(cols, sizeof(cols), "%d", j->cols);
    snprintf(rows, sizeof(rows), "%d", j->rows);
    RUN("resize-window", "-t", (char*)wid, "-x", cols, "-y", rows);
    free(out);
    json_object_array_add(tabs, tab);
  }
  if (json_object_array_length(ids)) {
    RUN("set-option", "-t", phone_session, "status", "off");
    free(out);
  }
  json_object_put(ids);
  json_object_object_add(reply, "tabs", tabs);
  json_object_object_add(reply, "cols", json_object_new_int(j->cols));
  json_object_object_add(reply, "rows", json_object_new_int(j->rows));
  j->reply = strdup(json_object_to_json_string(reply));
  json_object_put(reply);
  uv_mutex_unlock(&commands);
}
static void finished(uv_work_t* work, int status) {
  job* j = work->data;
  peer* p = j->client;
  p->busy = false;
  pending_jobs--;
  if (p->pss) {
    free(p->reply);
    p->reply = j->reply;
    lws_callback_on_writable(p->pss->wsi);
  } else {
    free(j->reply);
    free(p);
  }
  json_object_put(j->request);
  free(j);
}
void phone_open(struct pss_tty* pss) {
  peer* p = calloc(1, sizeof(peer));
  p->pss = pss;
  p->next = peers;
  peers = p;
  p->cols = 80;
  p->rows = 24;
  pss->phone = p;
}
void phone_close(struct pss_tty* pss) {
  peer* p = pss->phone;
  if (!p) return;
  peer** link = &peers;
  while (*link && *link != p) link = &(*link)->next;
  if (*link) *link = p->next;
  p->pss = NULL;
  free(p->reply);
  p->reply = NULL;
  if (!p->busy) free(p);
  pss->phone = NULL;
}
void phone_request(struct pss_tty* pss, const char* data, size_t len) {
  peer* p = pss->phone;
  if (p->busy || p->reply) return;
  json_tokener* tok = json_tokener_new();
  json_object* req = json_tokener_parse_ex(tok, data, len);
  json_tokener_free(tok);
  if (!req || !json_object_is_type(req, json_type_object)) {
    if (req) json_object_put(req);
    return;
  }
  p->seen = uv_hrtime() / 1000000;
  if (!p->used || number(req, "activity")) p->used = p->seen;
  p->phone = number(req, "phone") != 0;
  int cols = number(req, "cols"), rows = number(req, "rows");
  if (cols >= 2 && cols <= 500) p->cols = cols;
  if (rows >= 2 && rows <= 300) p->rows = rows;
  peer* owner = p;
  for (peer* other = peers; other; other = other->next)
    if (p->seen - other->seen < 45000 &&
        ((other->phone && !owner->phone) || (other->phone == owner->phone && other->used > owner->used)))
      owner = other;
  job* j = calloc(1, sizeof(job));
  j->work.data = j;
  j->client = p;
  j->request = req;
  j->cols = owner->cols;
  j->rows = owner->rows;
  p->busy = true;
  pending_jobs++;
  if (uv_queue_work(server->loop, &j->work, execute, finished)) {
    pending_jobs--;
    p->busy = false;
    json_object_put(req);
    free(j);
  }
}
int phone_write(struct pss_tty* pss) {
  peer* p = pss->phone;
  if (!p->reply) return 0;
  size_t n = strlen(p->reply);
  unsigned char* buf = malloc(LWS_PRE + n);
  memcpy(buf + LWS_PRE, p->reply, n);
  int result = lws_write(pss->wsi, buf + LWS_PRE, n, LWS_WRITE_TEXT);
  free(buf);
  free(p->reply);
  p->reply = NULL;
  return result < 0 ? -1 : 0;
}

void phone_shutdown(void) {
  /* Closed websocket peers remain alive until their pending command finishes. */
  while (pending_jobs) {
    uv_run(server->loop, UV_RUN_NOWAIT);
    uv_sleep(1);
  }
  uv_mutex_destroy(&commands);
}
