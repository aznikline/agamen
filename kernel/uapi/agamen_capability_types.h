/*
 * Agamen Capability Type Definitions — reference ABI seed
 *
 * Copied from agate hmkernel/kernel/include/mapi/uapi/agate/capability_types.h
 * (commit eb2cc3ee, post spec-14-P0.2: full rights mask, REVOKE/NOTIFY/WAIT
 * published, CAP_TYPE_CONTEXT added). Kept here as the canonical rights
 * algebra reference for every Agamen enforcement backend; the object-capability
 * invariants it encodes are specified in spec/invariants.md (#1, #2, #6).
 *
 * The rights-union rule for CAP_RIGHT_ALL is normative for all backends:
 * a literal mask is a bug waiting to happen (agate shipped 0xFF for months,
 * silently excluding three published rights).
 */

#ifndef UAPI_AGAMEN_CAPABILITY_TYPES_H
#define UAPI_AGAMEN_CAPABILITY_TYPES_H

/* ===== Capability Object Types ===== */
#define CAP_TYPE_NULL         0
#define CAP_TYPE_CNODE        1
#define CAP_TYPE_ENDPOINT     2
#define CAP_TYPE_VSPACE       3
#define CAP_TYPE_THREAD       4
#define CAP_TYPE_IRQ          5
#define CAP_TYPE_ACTV_POOL    6
#define CAP_TYPE_SHM          7
#define CAP_TYPE_NOTIFICATION 8
#define CAP_TYPE_DEVICE       9
#define CAP_TYPE_CONTEXT      10

/* ===== Capability Rights (bitmask) ===== */
#define CAP_RIGHT_READ    (1 << 0)
#define CAP_RIGHT_WRITE   (1 << 1)
#define CAP_RIGHT_EXECUTE (1 << 2)
#define CAP_RIGHT_SEND    (1 << 3)
#define CAP_RIGHT_RECV    (1 << 4)
#define CAP_RIGHT_GRANT   (1 << 5)
#define CAP_RIGHT_MAP     (1 << 6)
#define CAP_RIGHT_MANAGE  (1 << 7)
#define CAP_RIGHT_REVOKE  (1 << 8)
#define CAP_RIGHT_NOTIFY  (1 << 9)
#define CAP_RIGHT_WAIT    (1 << 10)
#define CAP_RIGHT_ALL     (CAP_RIGHT_READ | CAP_RIGHT_WRITE | CAP_RIGHT_EXECUTE | \
                           CAP_RIGHT_SEND | CAP_RIGHT_RECV | CAP_RIGHT_GRANT | \
                           CAP_RIGHT_MAP  | CAP_RIGHT_MANAGE | CAP_RIGHT_REVOKE | \
                           CAP_RIGHT_NOTIFY | CAP_RIGHT_WAIT)

#endif /* UAPI_AGAMEN_CAPABILITY_TYPES_H */
