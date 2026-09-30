package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters: OWASP's minimum profile (19 MiB, 2 passes). Chosen for a 1 GB VM
// shared with other projects; hashes store their parameters, so raising these later
// still verifies old hashes.
const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonKeyLen    = 32
	argonSaltLen   = 16
)

// hashSlots caps concurrent hashes so a burst of logins can't multiply the 19 MiB
// working set past the container's memory limit.
var hashSlots = make(chan struct{}, 2)

func withHashSlot[T any](f func() T) T {
	hashSlots <- struct{}{}
	defer func() { <-hashSlots }()
	return f()
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := withHashSlot(func() []byte {
		return argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	})
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

var errBadHash = errors.New("auth: malformed password hash")

func verifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, errBadHash
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, errBadHash
	}
	var mem, t uint32
	var p uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &t, &p); err != nil {
		return false, errBadHash
	}
	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false, errBadHash
	}
	want, err := b64.DecodeString(parts[5])
	if err != nil {
		return false, errBadHash
	}
	got := withHashSlot(func() []byte {
		return argon2.IDKey([]byte(password), salt, t, mem, p, uint32(len(want)))
	})
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}
