# app/command_handler.py
import importlib

def handle_command(message_text_original, config):
    """
    Dynamically handles commands based on the config file.
    It checks the lowercased version but passes the original to the command.
    """
    command_map = config.get("dynamic_commands", {})
    message_lower = message_text_original.lower()
    
    # Check if the beginning of the message matches a dynamic command
    for command_keyword in command_map:
        if message_lower.startswith(command_keyword):
            script_name = command_map[command_keyword]
            print(f"[DEBUG] Dynamic command '{command_keyword}' matched. Attempting to run script '{script_name}'.")
            
            try:
                command_module = importlib.import_module(f"commands.{script_name}")
                # Pass the original, un-lowercased message text to the command
                return command_module.execute(config, message_text_original)
                
            except ImportError:
                print(f"[ERROR] Could not import command module: commands.{script_name}.py")
                return f"Error: Command script '{script_name}.py' not found."
            except Exception as e:
                print(f"[ERROR] An error occurred while executing command '{script_name}': {e}")
                return f"Error executing command '{script_name}'."
                
    # If no command matched, return None
    return None