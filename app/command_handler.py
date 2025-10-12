# app/command_handler.py
import importlib

def get_command_class(command, config):
    """
    Dynamically finds and returns the class for a given command.
    """
    command_map = config.get("dynamic_commands", {})
    message_lower = command.lower()
    
    for command_keyword in command_map:
        if message_lower.startswith(command_keyword):
            script_name = command_map[command_keyword]
            class_name = "".join(word.capitalize() for word in script_name.split('_')) + "Command"
            
            try:
                command_module = importlib.import_module(f"commands.{script_name}")
                return getattr(command_module, class_name)
            except (ImportError, AttributeError):
                print(f"[ERROR] Could not find class '{class_name}' in 'commands/{script_name}.py'")
                return None
    return None