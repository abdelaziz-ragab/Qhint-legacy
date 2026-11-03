# Firebase Auth emulator for local development only.
FROM node:24-slim
RUN npm install -g firebase-tools@15.34.2 && npm cache clean --force
WORKDIR /srv
COPY firebase.json .firebaserc ./
EXPOSE 9099
HEALTHCHECK --interval=3s --timeout=3s --retries=40 \
  CMD node -e "fetch('http://127.0.0.1:9099/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["firebase", "emulators:start", "--only", "auth", "--project", "demo-qhint"]
