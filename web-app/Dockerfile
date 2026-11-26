# app.provian.ai: nginx serving the web export of the Provian app.
# Build context: web-app/ after scripts/deploy-web-app.sh has exported the app into web-app/dist.
FROM nginx:1.27-alpine
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/app.conf
COPY dist/ /usr/share/nginx/html/
# Refuse an image without the app in it.
RUN test -s /usr/share/nginx/html/index.html && ls /usr/share/nginx/html/_expo/static/js/web/*.js >/dev/null
EXPOSE 8080
