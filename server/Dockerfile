# The binary is cross-compiled by deploy.sh (static, linux/amd64), so the 1 GB VM never
# compiles Go: building modernc.org/sqlite needs more memory than the VM can spare.
FROM alpine:3.22
# ffmpeg/ffprobe for HLS remuxing (stream copy only, no encoding). A package install, not a
# compile, so this layer is cheap to build on the VM and cached afterwards.
RUN apk add --no-cache ffmpeg && adduser -D -H -u 10001 anda && mkdir /data && chown anda:anda /data
COPY bin/anda /usr/local/bin/anda
# The web app (Next.js static export), staged into bin/web by deploy.sh; served by the API.
COPY bin/web /srv/web
USER anda
ENV ANDA_ADDR=:8080 ANDA_DB=/data/anda.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
ENTRYPOINT ["anda"]
