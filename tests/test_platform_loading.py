"""Loading regressions: stable entry points, staged UI and enabled auth."""
import re


def test_existing_pages_load_and_unfinished_workspace_falls_back(client):
    for path in ('/', '/studio/', '/admin/', '/survey/beacon/test'):
        response = client.get(path)
        assert response.status_code == 200, path
        assert b'js/workspace.js' not in response.data
    response = client.get('/workspace/', follow_redirects=True)
    assert response.status_code == 200
    assert b'href="/studio/"' in response.data
    assert b'js/workspace.js' not in response.data


def test_staff_login_and_templates_work_with_auth_enabled(app, client):
    from core.security import create_user
    app.config['STAFF_AUTH'] = True
    with app.app_context():
        create_user('load-test-owner', 'test-only-long-password')
    assert client.get('/studio/').status_code == 302
    assert client.get('/api/studio/list').status_code == 401
    response = client.get('/login')
    assert response.status_code == 200
    token = re.search(rb'name="csrf" value="([^"]+)"', response.data).group(1).decode()
    response = client.post('/login', data={'username': 'load-test-owner',
        'password': 'test-only-long-password', 'csrf': token}, follow_redirects=True)
    assert response.status_code == 200
    for path in ('/', '/studio/', '/admin/'):
        response = client.get(path)
        assert response.status_code == 200, path
        assert b'csrf-token' in response.data
    assert client.post('/api/studio/save', json={}).status_code == 403
    assert client.get('/logout').status_code == 405
