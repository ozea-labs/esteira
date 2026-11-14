# Imagem mínima do self-test: só prova o caminho build → smoke → scan → digest.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f AS runtime
COPY src/ /app/src/
RUN adduser -D -H app
USER app
CMD ["cat", "/app/src/Greeter.php"]
