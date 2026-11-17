#ifndef TTYP_PHONE_H
#define TTYP_PHONE_H
#include <stddef.h>
struct pss_tty;
extern char *phone_socket, *phone_session;
int phone_setup(void);
void phone_shutdown(void);
void phone_open(struct pss_tty* pss);
void phone_close(struct pss_tty* pss);
void phone_request(struct pss_tty* pss, const char* data, size_t len);
int phone_write(struct pss_tty* pss);
#endif
