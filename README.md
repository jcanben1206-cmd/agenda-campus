# Agenda Campus

## Abrir desde GitHub Pages

El flujo **Publish Agenda Campus** publica `Web/dist` mediante GitHub Actions. En el repositorio de GitHub, selecciona **Settings → Pages → Source → GitHub Actions** y ejecuta el flujo en la rama principal. Abre la URL que muestra la publicación.

Para conectar Moodle en la web alojada, recarga la extensión en `chrome://extensions` y abre **Detalles → Opciones de extensión**. En **GitHub Pages**, pega la URL publicada y pulsa **Vincular web**. Autoriza el dominio en Chrome y recarga la web. La extensión entrega los datos de Moodle al navegador desde su almacenamiento local. GitHub Pages sirve la interfaz estática.

El sitio de GitHub Pages es visible públicamente en la configuración habitual. La publicación contiene la interfaz web. Si utilizas la extensión, las credenciales se guardan en Chrome. Los exámenes y calendarios importados manualmente desde la dirección anterior pertenecen a ese origen del navegador y tienes que volver a añadirlos o importarlos en la dirección nueva.

### Sincronizar desde un servidor privado

1. En Render, crea un **Blueprint** desde este repositorio. El archivo `render.yaml` crea un servicio web con una API protegida por una clave de acceso.
2. En el formulario de Render, introduce `MOODLE_USERNAME` y `MOODLE_PASSWORD` como variables de entorno. Render genera `AGENDA_ACCESS_KEY`. Las tres variables se configuran en Render y sus valores quedan fuera del repositorio.
3. Abre Agenda Campus y ve a **Ajustes → Cuenta de Moodle Sevilla → Conectar servidor privado**. Pega la dirección del servicio de Render y el valor de `AGENDA_ACCESS_KEY`. Pulsa **Conectar y actualizar**.
4. Comprueba que aparecen tus fechas y estados. A partir de ahí, puedes usar **Actualizar ahora** sin la extensión. Con la IA local activada, la agenda también comprueba Moodle al abrirla en una pestaña con la clave activa.

El navegador conserva la clave de acceso durante la sesión de la pestaña. Render consulta el mes actual y el siguiente bajo demanda. La caché del servidor se guarda en memoria, por lo que el primer acceso después de un reinicio puede necesitar una comprobación nueva. El acceso real depende de que EducaAnd admita el inicio de sesión desde Render.

## Demo web local para Windows

1. En el Explorador de archivos, abre la carpeta `Web` y haz doble clic en **Abrir en Windows.cmd**. Se abre tu navegador habitual en `http://127.0.0.1:8765/`.
2. Deja abierta la ventana del servidor mientras usas la demo. Los exámenes se guardan en el navegador. Cierra la ventana del servidor cuando termines.

El lanzador de Windows sirve la web solo en ese ordenador.

### Actualizar desde Moodle Sevilla en Chrome

1. Abre `chrome://extensions`, activa **Modo de desarrollador** y pulsa **Cargar descomprimida**. Selecciona la carpeta `Web/chrome-extension`.
2. Abre o recarga Agenda Campus en `http://127.0.0.1:8765/` con el mismo Chrome.
3. En Agenda Campus, abre **Calendario → Sincronización con Moodle → Abrir el calendario de Moodle Sevilla**. Inicia sesión en el portal y entra en la vista mensual de tu calendario general. Si tras iniciar sesión llegas al inicio de Moodle, vuelve a pulsar el enlace.
4. La extensión comprueba el mes actual y el siguiente al abrir el calendario mensual de Moodle. Con esa pestaña cerrada, puedes comprobar los cambios en **Ajustes → Cuenta de Moodle Sevilla → Actualizar ahora**. El botón usa una pestaña temporal que se cierra al terminar. Los eventos y estados solo se vuelven a guardar cuando cambian.

Si ya tenías cargada la extensión, pulsa **Recargar** en `chrome://extensions`, confirma el acceso adicional al portal oficial de EducaAnd si Chrome lo pide y recarga la agenda y el calendario de Moodle una vez. Si guardaste tus credenciales con el gestor de Chrome y este rellena el formulario oficial en segundo plano, la extensión intenta enviarlo una vez por caducidad. Si Chrome exige interacción, vuelve a entrar desde Moodle. La extensión guarda el resultado de la sincronización y el indicador de intento en el navegador.

Para guardar las credenciales directamente en la extensión, entra en **Ajustes → Cuenta de Moodle Sevilla → Configurar acceso automático** desde Agenda Campus. El formulario se abre en una página de la extensión. Los datos se guardan cifrados en este perfil de Chrome y se usan en el formulario oficial de EducaAnd durante una actualización en segundo plano. Puedes borrarlos desde ese mismo formulario.

En **Ajustes → IA local** puedes activar Gemini Nano de Chrome. Con la opción activa, se realiza una sola comprobación al abrir o recargar la agenda. El modelo resume únicamente las diferencias detectadas y requiere una versión compatible de Chrome y la descarga inicial del modelo. La extensión maneja el inicio de sesión. El modelo trabaja con títulos, fechas y estados.

La extensión utiliza el calendario mensual que Moodle muestra en el navegador. Los meses se sustituyen al volver a abrirlos y prevalecen sobre el archivo importado para ese mismo mes. Para las entregas del mes actual y el siguiente, también consulta la ficha de la tarea y clasifica los estados reconocidos como entregada, borrador o sin entregar. Las tareas cuyo estado no se pudo leer aparecen en **Sin verificar**. Las fechas leídas de la vista mensual representan días completos. Quitar la extensión de Chrome borra su calendario guardado.

### Importar el calendario de Moodle

Inicia sesión en Moodle desde tu navegador. En **Calendario → Exportar calendario**, elige los eventos y el periodo y pulsa **Exportar** para descargar el archivo `.ics`. En Agenda Campus, selecciona ese archivo en **Calendario → Sincronización con Moodle**.

Los eventos quedan guardados en el navegador junto a tus exámenes. Cada nueva importación reemplaza la anterior. Los archivos `.ics` contienen fechas de eventos, y el estado de entrega se sigue consultando en Moodle.

## Prueba opcional en iPhone

1. En el Explorador de archivos, abre la carpeta `Web` y haz doble clic en **Probar en iPhone.cmd**. Deja abierta la ventana. Si Windows pregunta por el firewall, permite el acceso en la red privada donde vas a hacer la prueba.
2. Conecta el PC y el iPhone a la misma Wi-Fi. En Safari, escribe la dirección **En Safari** de la interfaz Wi-Fi que aparece en la ventana, incluido `http://` y el puerto.
3. Guarda un examen y comprueba que aparece en el calendario. Los exámenes se conservan en Safari para esa dirección. Cierra la ventana de Windows cuando termines.

En Safari puedes importar un calendario de Moodle y guardar exámenes en el navegador. La sincronización automática de la web requiere la extensión de Chrome en Windows.

En el PC también puedes abrir `Web/dist/index.html` para ver la demo directamente. Usa la dirección HTTP que imprime el lanzador para probar el guardado tal como se usa desde el móvil.

## Proyecto iOS

Prototipo nativo para iPhone con SwiftUI. Requiere iOS 17 o posterior.

## Probar el prototipo

1. Abre `AgendaCampus.xcodeproj` en Xcode desde un Mac.
2. Selecciona el esquema `AgendaCampus` y un simulador de iPhone. Ejecuta la app con ⌘R. Para probar en un iPhone físico, selecciona tu equipo en **Signing & Capabilities**.
3. Abre **Tareas** y activa **Solo pendientes** para ver las entregas de ejemplo. En **Calendario** puedes consultar las actividades de cada día.
4. Crea un examen en **Exámenes** y activa los avisos en **Ajustes**. Para comprobar un aviso en un iPhone, programa un examen para una hora y dos minutos más tarde, concede permiso a la app y mándala a segundo plano. El aviso de una hora se programa para unos dos minutos después.

## Conectar Moodle

Introduce en **Ajustes** la dirección HTTPS base del centro y un token de servicios web de una cuenta de prueba. El servicio REST debe permitir `mod_assign_get_assignments` y `mod_assign_get_submission_status` para esa cuenta. Usa la dirección final del sitio, incluidos los directorios si los hay. La app envía el token en el cuerpo de la petición y lo mantiene en memoria durante la sesión.

La sincronización manual carga las actividades de tipo **Tarea** disponibles para la cuenta. El estado «Sin verificar» indica que Moodle no devolvió información suficiente para confirmar la entrega. El filtro de pendientes y sus recordatorios se basan en estados confirmados. Las tareas sincronizadas y los exámenes que añadas se guardan en el dispositivo.

iOS programa los avisos locales de una hora y 24 horas para plazos futuros. También avisa al vencimiento si la tarea figuraba como pendiente en la última sincronización. El prototipo programa hasta 60 avisos próximos y actualiza la programación al cambiar los datos o al volver a la app. Los cambios que el centro haga en Moodle aparecen tras volver a sincronizar.

## Camino hacia App Store

- Probar con el Moodle del centro y validar borradores, entregas grupales, ampliaciones de plazo y permisos de estudiantes.
- Definir cómo iniciarán sesión los estudiantes en función del acceso que permita el centro. Decidir cómo se detectarán los cambios en Moodle con la app cerrada y, si se necesitan avisos remotos, implementar un servicio de sincronización con APNs.
- Elegir el identificador definitivo, añadir el icono y preparar la información de privacidad y los materiales de App Store Connect. Distribuir primero por TestFlight para probar en dispositivos reales.
