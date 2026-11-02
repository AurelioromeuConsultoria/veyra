"""Coolify simulado, em HTTPS local, para o ensaio da publicação pelo CI (ADR-058).

Responde só ao que o .github/scripts/staging-deploy.sh pede, no formato que o
código-fonte do Coolify devolve. O cenário vem de CENARIO; nada sai da máquina.
"""
import json
import os
import ssl
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

CEN = os.environ['CENARIO']
SHA = os.environ['SHA_TESTADO']
BASE = os.environ['BASE_NO_AR']
OUTRO = os.environ.get('OUTRO', '')
TOKEN = os.environ['TOKEN_ESPERADO']
estado = {'polls': 0}


def deploys():
    if CEN == 'sem-base':
        return {'count': 1, 'deployments': [{'status': 'finished', 'commit': 'HEAD', 'pull_request_id': 0, 'is_webhook': False}]}
    base = {'status': 'finished', 'commit': SHA if CEN == 'base-igual' else BASE, 'pull_request_id': 0, 'is_webhook': CEN == 'base-webhook'}
    if CEN == 'origem-desconhecida':
        del base['is_webhook']
    lista = [{'status': 'failed', 'commit': 'a' * 40, 'pull_request_id': 0, 'is_webhook': False},
             {'status': 'finished', 'commit': 'b' * 40, 'pull_request_id': 7, 'is_webhook': False},
             base]
    if CEN == 'em-curso':
        lista.insert(0, {'status': 'in_progress', 'commit': 'HEAD', 'pull_request_id': 0, 'is_webhook': False})
    return lista if CEN == 'lista-crua' else {'count': len(lista), 'deployments': lista}


class Coolify(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, codigo, corpo):
        b = json.dumps(corpo).encode()
        self.send_response(codigo)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _autorizado(self):
        if self.headers.get('Authorization') != f'Bearer {TOKEN}':
            self._json(401, {'message': 'Unauthenticated.'})
            return False
        return True

    def do_GET(self):
        rota = self.path.split('?')[0]
        if rota == '/api/health':
            return self._json(503 if CEN == 'sem-saude' else 200, {'status': 'ok'})
        if not self._autorizado():
            return
        if rota == '/api/v1/applications/app':
            if CEN == 'recurso-nao-objeto':
                return self._json(200, 'texto')
            app = {'uuid': 'app', 'git_branch': 'main', 'git_commit_sha': 'HEAD',
                   'settings': {'is_auto_deploy_enabled': CEN == 'auto-ligado'}}
            if CEN in ('auto-desconhecido', 'origem-desconhecida'):
                del app['settings']
            if CEN == 'fixado':
                app['git_commit_sha'] = '2b6deb1'
            if CEN == 'outro-ramo':
                app['git_branch'] = 'proposta/x'
            if CEN == 'sem-campos':
                del app['git_branch'], app['git_commit_sha']
            return self._json(200, app)
        if rota == '/api/v1/deployments/applications/app':
            return self._json(200, deploys())
        if rota == '/api/v1/deploy':
            if CEN == 'so-get':
                return self._json(200, {'deployments': [{'message': 'queued', 'resource_uuid': 'app', 'deployment_uuid': 'dep-1'}]})
            return self._json(405, {'message': 'use POST'})
        if rota == '/api/v1/deployments/dep-1':
            estado['polls'] += 1
            if CEN == 'api-instavel' and estado['polls'] in (1, 2):
                return self._json(502, {'message': 'bad gateway'})
            if CEN == 'api-caiu':
                return self._json(502, {'message': 'bad gateway'})
            if estado['polls'] < 4:
                return self._json(200, {'status': 'in_progress', 'commit': 'HEAD'})
            if CEN == 'falhou':
                return self._json(200, {'status': 'failed', 'commit': SHA})
            if CEN.startswith('commit-trocado'):
                return self._json(200, {'status': 'finished', 'commit': OUTRO})
            if CEN == 'commit-head':
                return self._json(200, {'status': 'finished', 'commit': 'HEAD'})
            return self._json(200, {'status': 'finished', 'commit': SHA})
        self._json(404, {'message': 'not found'})

    def do_POST(self):
        if not self._autorizado():
            return
        if self.path.split('?')[0] == '/api/v1/deploy':
            if CEN == 'so-get':
                return self._json(405, {'message': 'Method Not Allowed'})
            if CEN == 'erro-com-quebra':
                return self._json(500, {'message': 'linha1\r\n::warning::injetado'})
            return self._json(200, {'deployments': [{'message': 'queued', 'resource_uuid': 'app', 'deployment_uuid': 'dep-1'}]})
        self._json(404, {'message': 'not found'})


servidor = HTTPServer(('127.0.0.1', int(sys.argv[1])), Coolify)
contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
contexto.load_cert_chain(sys.argv[2], sys.argv[3])
servidor.socket = contexto.wrap_socket(servidor.socket, server_side=True)
servidor.serve_forever()
