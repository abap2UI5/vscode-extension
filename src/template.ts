/*
 * The app skeletons "New App from Template" offers. They build their views
 * with z2ui5_cl_ai_xml on purpose: that is the builder abap2UI5 is
 * standardising on, and the only one the view check can reconstruct - a
 * template using the older z2ui5_cl_xml_view handed out a class the
 * extension's own checker then ignored.
 *
 * Every template follows the corpus recipe: `main` dispatches on
 * `check_on_init` / `check_on_event`, events are handled in a CASE, model
 * data lives in PUBLIC attributes bound with `client->_bind( )`, and
 * `model_init` goes last. The test suite runs each template through the
 * bundled linter, so a template cannot teach what the linter reports.
 *
 * Its own module so both entries (desktop and web) share it without the web
 * bundle dragging in the desktop plumbing.
 */

export interface AppTemplate {
  id: string;
  /** Label in the template picker. */
  label: string;
  /** One line under the label. */
  description: string;
  /** The class source, class name `zcl_my_app` - replaced by the wizard. */
  source: string;
}

const EMPTY = `CLASS zcl_my_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_my_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( n = \`Page\`
        )->a( n = \`title\` v = \`Hello abap2UI5\`
        )->leaf( n = \`Text\`
        )->a( n = \`text\` v = \`My first app\` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
`;

const LIST = `CLASS zcl_my_app DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_product,
             name  TYPE string,
             price TYPE p LENGTH 8 DECIMALS 2,
           END OF ty_s_product.
    DATA mt_products TYPE STANDARD TABLE OF ty_s_product WITH EMPTY KEY.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_my_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( \`Page\`
            )->a( n = \`title\` v = \`Products\`
            )->open( \`Table\`
                )->a( n = \`items\` v = client->_bind( mt_products )
                )->open( \`columns\`
                    )->open( \`Column\`
                        )->leaf( \`Text\`
                            )->a( n = \`text\` v = \`Name\`

                    )->shut(
                    )->open( \`Column\`
                        )->leaf( \`Text\`
                            )->a( n = \`text\` v = \`Price\`

                    )->shut(
                )->shut(
                )->open( \`items\`
                    )->open( \`ColumnListItem\`
                        )->open( \`cells\`
                            )->leaf( \`Text\`
                                )->a( n = \`text\` v = \`{NAME}\`
                            )->leaf( \`Text\`
                                )->a( n = \`text\` v = \`{PRICE}\` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD model_init.

    mt_products = VALUE #( ( name = \`Notebook 17"\` price = '999.00' )
                           ( name = \`Monitor 27"\`  price = '249.50' )
                           ( name = \`Keyboard\`     price = '39.90' ) ).

  ENDMETHOD.
ENDCLASS.
`;

const FORM = `CLASS zcl_my_app DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA mv_name  TYPE string.
    DATA mv_email TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.

  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_my_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( \`Page\`
            )->a( n = \`title\` v = \`Form\`
            )->open( \`VBox\`
                )->leaf( \`Label\`
                    )->a( n = \`text\` v = \`Name\`
                )->leaf( \`Input\`
                    )->a( n = \`value\` v = client->_bind( mv_name )
                )->leaf( \`Label\`
                    )->a( n = \`text\` v = \`E-mail\`
                )->leaf( \`Input\`
                    )->a( n = \`value\` v = client->_bind( mv_email )
                )->leaf( \`Button\`
                    )->a( n = \`text\`  v = \`Save\`
                    )->a( n = \`press\` v = client->_event( \`SAVE\` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get( )-event.
      WHEN \`SAVE\`.
        client->message_toast_display( |Saved { mv_name }| ).
    ENDCASE.

  ENDMETHOD.
ENDCLASS.
`;

const MASTER_DETAIL = `CLASS zcl_my_app DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_item,
             title TYPE string,
             descr TYPE string,
           END OF ty_s_item.
    DATA mt_items    TYPE STANDARD TABLE OF ty_s_item WITH EMPTY KEY.
    DATA mv_selected TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS model_init.

  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_my_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      model_init( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( \`Page\`
            )->a( n = \`title\` v = \`Master & Detail\`
            )->open( \`List\`
                )->a( n = \`headerText\` v = \`Items\`
                )->a( n = \`items\`      v = client->_bind( mt_items )
                )->leaf( \`StandardListItem\`
                    )->a( n = \`title\`       v = \`{TITLE}\`
                    )->a( n = \`description\` v = \`{DESCR}\`
                    )->a( n = \`type\`        v = \`Active\`
                    )->a( n = \`press\`       v = client->_event( val = \`PICK\` t_arg = VALUE #( ( \`\${TITLE}\` ) ) )

            )->shut(
            )->open( \`Panel\`
                )->a( n = \`headerText\` v = \`Detail\`
                )->leaf( \`Text\`
                    )->a( n = \`text\` v = client->_bind( mv_selected ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get( )-event.
      WHEN \`PICK\`.
        mv_selected = client->get_event_arg( ).
    ENDCASE.

  ENDMETHOD.

  METHOD model_init.

    mt_items = VALUE #( ( title = \`First\`  descr = \`The first item\` )
                        ( title = \`Second\` descr = \`The second item\` )
                        ( title = \`Third\`  descr = \`The third item\` ) ).

  ENDMETHOD.
ENDCLASS.
`;

const POPUP = `CLASS zcl_my_app DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    METHODS view_display.
    METHODS on_event.
    METHODS popup_open.

  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_my_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    me->client = client.
    IF client->check_on_init( ).
      view_display( ).
    ELSEIF client->check_on_event( ).
      on_event( ).
    ENDIF.

  ENDMETHOD.

  METHOD view_display.

    DATA(view) = z2ui5_cl_ai_xml=>factory( ).
    view->open( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->open( \`Page\`
            )->a( n = \`title\` v = \`Popup\`
            )->leaf( \`Button\`
                )->a( n = \`text\`  v = \`Open dialog\`
                )->a( n = \`press\` v = client->_event( \`OPEN\` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD on_event.

    CASE client->get( )-event.
      WHEN \`OPEN\`.
        popup_open( ).
      WHEN \`POPUP_CLOSE\`.
        client->popup_destroy( ).
    ENDCASE.

  ENDMETHOD.

  METHOD popup_open.

    DATA(popup) = z2ui5_cl_ai_xml=>factory( ).
    popup->open( \`Dialog\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`title\` v = \`My Dialog\`
        )->open( \`content\`
            )->leaf( \`Text\`
                )->a( n = \`text\` v = \`Dialog content\`

        )->shut(
        )->open( \`buttons\`
            )->leaf( \`Button\`
                )->a( n = \`text\`  v = \`Close\`
                )->a( n = \`press\` v = client->_event( \`POPUP_CLOSE\` ) ).

    client->popup_display( popup->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
`;

export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: "empty",
    label: "Empty view",
    description: "One page, one text - the smallest running app",
    source: EMPTY,
  },
  {
    id: "list",
    label: "List",
    description: "A table over an internal table, with columns and mock rows",
    source: LIST,
  },
  {
    id: "form",
    label: "Form",
    description: "Inputs bound two-way, a Save button and its event handler",
    source: FORM,
  },
  {
    id: "master-detail",
    label: "Master & detail",
    description: "A list whose press event fills a detail panel",
    source: MASTER_DETAIL,
  },
  {
    id: "popup",
    label: "Popup",
    description: "A button that opens a dialog, close handled in the CASE",
    source: POPUP,
  },
];

/** One template's source with the class renamed. */
export function templateSource(template: AppTemplate, className: string): string {
  return template.source.replace(/zcl_my_app/g, className.toLowerCase());
}

/** The skeleton "Insert App Template" has always inserted - the first entry
 *  of the gallery, kept as its own export for the welcome screen and tests. */
export const APP_TEMPLATE = EMPTY;
