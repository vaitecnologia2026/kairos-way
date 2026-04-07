# Kairos Way — Gateway de Pagamentos White Label

Backend completo desenvolvido com Node.js + Fastify + PostgreSQL + Redis + BullMQ.

## Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Fastify 4
- **ORM:** Prisma 5
- **Banco:** PostgreSQL 16
- **Cache / Filas:** Redis 7 + BullMQ
- **Deploy:** Railway

## Início rápido

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Editar .env com suas credenciais

# 3. Criar banco e rodar migrations
npm run db:migrate

# 4. Popular banco (dados iniciais)
npm run db:seed

# 5. Iniciar servidor em desenvolvimento
npm run dev
```

## Credenciais iniciais (após seed)

| Perfil    | Email                          | Senha             |
|-----------|-------------------------------|-------------------|
| Admin     | admin@kairosway.com.br        | KairosWay@2026!   |
| Produtor  | produtor@kairosway.com.br     | KairosWay@2026!   |

> ⚠️ **Trocar as senhas imediatamente após o primeiro acesso.**

## Scripts disponíveis

| Script                  | Descrição                                    |
|-------------------------|----------------------------------------------|
| `npm run dev`           | Desenvolvimento com hot-reload               |
| `npm run build`         | Build de produção (TypeScript → JavaScript)  |
| `npm run start`         | Iniciar build de produção                    |
| `npm run db:migrate`    | Rodar migrations em desenvolvimento          |
| `npm run db:migrate:prod` | Aplicar migrations em produção             |
| `npm run db:seed`       | Popular banco com dados iniciais             |
| `npm run db:generate`   | Gerar Prisma Client                          |
| `npm run db:studio`     | Abrir Prisma Studio (visual do banco)        |

## Docker

```bash
# Subir toda a stack (API + PostgreSQL + Redis)
docker compose up -d

# Rodar migrations no container
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed
```

## Deploy Railway

Consulte o arquivo `kairos-way-install-guide.docx` para instruções completas de deploy no Railway.

## Documentação

- **Guia de instalação:** `kairos-way-install-guide.docx`
- **Guia técnico completo:** `kairos-way-dev-guide.docx`

## Segurança (PCI DSS)

- ✅ MFA obrigatório para Admin (REQ-8)
- ✅ Bloqueio após 6 tentativas (REQ-8)
- ✅ Sessão expira em 15 min (REQ-8)
- ✅ Audit log completo (REQ-10)
- ✅ Tokens de cartão nunca armazenados (REQ-3)
- ✅ RBAC com 4 perfis (REQ-7)
- ✅ Valores sempre em centavos (sem float)
- ✅ Splits imutáveis

## Desenvolvido por

**VAI Inteligência Comercial** — [app.vaicrm.com.br](https://app.vaicrm.com.br)
