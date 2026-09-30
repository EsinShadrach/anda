# out/ is the Next.js static export, built by deploy.sh on the dev machine (no Node on the VM).
FROM nginx:alpine
COPY nginx.conf /etc/nginx/nginx.conf
COPY out/ /usr/share/nginx/html/
