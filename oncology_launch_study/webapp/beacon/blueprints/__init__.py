from .admin import bp as admin_bp
from .studio import bp as studio_bp
from .survey import bp as survey_bp

__all__ = ["survey_bp", "studio_bp", "admin_bp"]
