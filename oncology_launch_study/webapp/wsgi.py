"""WSGI entry point:  gunicorn -w 2 -b 0.0.0.0:8000 wsgi:app"""
from beacon import create_app

app = create_app()
